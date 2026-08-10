# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed (money-visibility) — pinned tokens were advertised as spendable, and the refusal lied (#737)

A wallet whose gateway stopped confirming certifications reported ~1M UCT **confirmed** while every
`send()` was refused with `SEND_INSUFFICIENT_BALANCE`, for five days, on two SDK versions. The
certification outage was upstream; two SDK defects turned it into an unexplainable permanent
lockout:

- **The confirmed balance lied.** A send that ends keep-open deliberately RETAINS its source
  reservation (releasing risks double-paying a spend that may be on-chain), but `assets()` keyed
  its transferring/confirmed split on `InventoryView`'s own in-flight set, which knows only about
  the attempt still running in this session. After a restart the ledger was empty, the still-open
  intent's sources were re-offered by `pool()` and counted as confirmed again. Reporting now reads
  the reservation itself (`isPinned`), and `IntentPins` (`select/pins.ts`) re-derives the pins from
  the §6 intent backstop at `start()` and after every convergence pass — so a pinned source reads
  as `transferring` across a restart, and an intent that stops being open stops pinning. No new
  durable state, no reservation released while its intent is open.
- **The refusal misled.** `SEND_INSUFFICIENT_BALANCE` keeps its code (dApps key on it) but the
  message now names the pin: free total, pinned total, how many transfers hold it, a pointer to
  `payments.pendingTransfers()` and "do not re-send". With nothing pinned the wording is unchanged.

### Fixed (BREAKING, money) — the cross-network recipient guard was unfalsifiable (#733)

`resolveRecipientInfo` stamped the LOCAL session network onto every `RecipientInfo`, so
`PaymentsFacade`'s §5.6 guard compared the session network with a copy of itself and could never
fire; its only test injected a fake resolver. All networks share Nostr relays, so a
foreign-network peer resolves fine, the deposit is keyed under the SENDER's network, the server
answers 200, and the delivery-journal row — the sender's only copy of the obligation — is dropped
while the recipient never sees the entry.

`RecipientInfo.network` is now `string | null` (**breaking** for anyone constructing one) and
carries only what the identifier proves: a bare chain pubkey stays session-stamped (typing one
into this session is the caller asserting it), a resolved peer reports `PeerInfo.network ?? null`.
`PeerInfo` gains an optional `network`, parsed from the identity binding wherever one declares it
and invented nowhere. The guard refuses a PROVEN foreign network with `INVALID_RECIPIENT` before
any reserve/intent/engine work.

Transition posture (#734): no identity binding published so far declares a network — nostr-js-sdk's
binding builders whitelist the content fields, so the claim cannot ride today's publish API at all
— and refusing every unproven recipient would stop nametag/`DIRECT://` sends between current
wallets. An unproven recipient therefore **proceeds** and emits
`transfer:attention { code: 'recipient:network-unverified' }` (exported as
`ATTENTION_RECIPIENT_NETWORK_UNVERIFIED`). #734 tracks putting the field on the publish side and
tightening this to a hard refusal.

Reading the claim is **per-route**, and the limitation is stated where it bites: sphere parses it
off the raw signed event on the routes that own the parse (`resolveTransportPubkeyInfo`,
`discoverAddresses`), where a proven foreign network is refused end to end. `@nametag` and
`DIRECT://` resolve through nostr-js-sdk's `queryBindingBy*`, whose `parseBindingInfo` whitelists
the network away and never returns the selected signed event, so those two recipients can only be
SIGNALLED until #734 lands upstream — `bindingInfoToPeerInfo` carries no network at all rather
than a read that cannot fire, and `tests/unit/payments-v2/recipient-network.transport.test.ts`
drives relay → transport → resolver → gate per route to keep both halves honest.

### Added — `payments.connectionStatus()` (sphere#473 P1)

The current wallet-api connection status is now readable at any time, not only observable at
transition: `sphere.payments.connectionStatus()` returns `'connected' | 'degraded' | 'offline'`
(never null; `'offline'` while the vertical is unstarted). `connection:status` stays the change
notification — a component mounting after a transition (the header indicator vs. an `offline`
sign-in during `Sphere.init`, where a persistent outage produces no further transition) seeds from
the getter. Both read the session's one status value (`FacadeSession.status()` is now REQUIRED),
so the getter and the event cannot disagree. This replaces the pre-flip `sphere.walletApiSessionStatus`
getter, which the flip deleted without a replacement.

### Changed — P11 flip (BREAKING): the payments-v2 vertical is the ONLY money path

`sphere.payments` now IS the §4 facade (`assets()`, `tokens()`, `history()`, `send()`, `mint()`,
`receive()`, `requests`); `sphere.paymentsV2` remains as a deprecated alias of the same facade for
one release. `Sphere.init` is fail-closed on the wallet-api composition: pass
`walletApi: { network, baseUrl, deviceId?, fetchFn?, webSocketFactory? }` (built by
`createWalletApiProviders` from `impl/shared/wallet-api`) or init throws `INVALID_CONFIG`. The
`paymentsV2` init flag is accepted as a no-op for one release.

Removed wholesale: the legacy `PaymentsModule` stack (`modules/payments`), the accounting/invoicing
module (`modules/accounting`), the swap module (`modules/swap`), the S1 `WalletApiClient` stack
(`wallet-api/` and its `./wallet-api` subpath — the §4 challenge-template contract strings live on
in `core/wallet-api-protocol`, still exported from the root), the own-storage token custody
(`TokenStorageProvider` port, `IndexedDBTokenStorageProvider`, `FileTokenStorageProvider`,
`WalletApiTokenStorageProvider`, `tokenStorage`/`tokensDir` composition options), the S7
`DeliveryProvider` port, the Nostr asset/payment-request rail (event kinds 31113/31115/31116 and
every `sendTokenTransfer`/`sendPaymentRequest*` transport member), `types/v2-transfer`, the TXF
type/serializer pair (`types/txf`, `serialization/txf-serializer`), `validation/`
(`TokenValidator`), the old-module events (`transfer:confirmed/failed/delivery_pending/invalid`,
`payment_request:paid/rejected/expired/settling/response`, `sync:*`, `storage:degraded`,
`split:checkpoint-stuck`, `send:partial-remainder`, `delivery:*`, `walletapi:session`,
`realtime:status`, all `invoice:*`, all `swap:*` — dApps keep receiving the old wire names through
the ConnectHost §4 compat adapter), `sphere.sync()`, `startWalletApiSession`/`resumeOpenIntents`
(resume runs inside `facade.start()`), `walletApiSessionStatus`, and the dead storage-key
constants whose writers died with the modules. `Sphere.clear` collapses to `{ storage }`, wipes
the `pv2:{network}:{pubkey}:*` scoped KV with the KV store, and sweeps orphaned pre-flip
`sphere-token-storage-*` IndexedDB databases.

**The Connect invoice surface is removed from the protocol:** the 2 invoice queries
(`sphere_getInvoices`, `sphere_getInvoiceStatus`), all 9 invoice intents and the
`invoice:read`/`invoice:write` scopes — the wire surface is now 14 queries / 6 intents /
13 scopes. The protocol version stays 2.1 by owner decision: the surface was experimental,
never enabled in any wallet host (every call answered `MODULE_NOT_AVAILABLE`), and the
consumer gate found zero dApp users; a removed method now answers the standard
`METHOD_NOT_FOUND` path. Everything else on the wire is preserved by the §4 compat adapter —
dApps change nothing.

**The ONE sanctioned refusal fossil (revisit-and-delete after one release):** `accounting: true` /
`swap: true` in init options throw a typed `INVALID_CONFIG` with a pointing message — both were
public API, and silently ignoring them would hide that invoices/swaps no longer exist in the SDK.

**Scale (per the flip manifest):** old modules deleted 23,905 lines (`modules/payments` 8,231 ×12
files; `modules/accounting` 9,315 ×7; `modules/swap` 6,359 ×7) + `wallet-api/` 2,657 ×8 + the old
`impl/shared/wallet-api` providers 1,756 ×5 + both platform token-storage providers 976 + ports,
rails, types, serializers and constants; test estate: ≈113 old-stack test files (≈52,000 lines)
deleted, ~12 rewritten onto the flip contract, the v2 suite (19 files / 8,485 lines + port
contracts + 17 mutation probes) stands. Docs rewritten to the v2 reality: CLAUDE.md, README,
QUICKSTART-BROWSER/NODEJS, INTEGRATION (invoice section deleted), CONNECT (compat adapter
documented), API, MIGRATION-PAYMENTS-V2 (flip-release note), LEGACY-INVENTORY (CLOSED-BY-P11
reconciliation), PAYMENTS-V2-DESIGN (P11 progress). Directory names deliberately stay
`modules/payments-v2` / `impl/wallet-api-v2` (subpath exports were keeping those names anyway —
the §5 `git mv` is deferred, zero consumer impact).

### Fixed — CHANGELOG prose for the `wallet.dat` importer removal (#722)

The entry below previously claimed `Sphere.importFromLegacyFile`, `Sphere.detectLegacyFileType`,
`Sphere.isLegacyFileEncrypted` and the `LegacyFileType`/`DecryptionProgressCallback` types were
removed. The code kept them (the live frontend onboarding calls all three for `.txt`/JSON/mnemonic
backups); only the `.dat` (Bitcoin Core) arm was removed. The prose below is corrected — code is
authoritative.

### Removed — the Bitcoin Core `wallet.dat` importer

`serialization/wallet-dat.ts` is gone in full: the SQLite byte-scan, the `mkey`/CMasterKey
extraction, the iterated-SHA512 (PBKDF2-style) key derivation, and every export of the module
(`parseWalletDat`, `parseAndDecryptWalletDat`, `isSQLiteDatabase`, `isWalletDatEncrypted`,
`decryptCMasterKey`, `decryptPrivateKey`, `CMasterKeyData`, `WalletDatInfo`). The wallet has been
L3-only since #604 — there is no Bitcoin Core wallet to import from.

`Sphere.importFromLegacyFile`, `Sphere.detectLegacyFileType` and `Sphere.isLegacyFileEncrypted`
were KEPT — their `.txt` / flat-JSON / bare-mnemonic arms are the live onboarding path — with the
`.dat` arm deleted (a `wallet.dat` file now reports "Unknown file format"). The
`LegacyFileType`/`DecryptionProgressCallback` types stay with them; only the `.dat`-specific
`LegacyFileInfo`/`LegacyFileImportOptions` shapes and the `encryptionInfo` field went.

**The text backup path is NOT removed.** `sphere.exportToTxt()` (and the browser
`downloadWalletBackup` helper) still writes password-encrypted `UNICITY WALLET DETAILS` files, so
`serialization/wallet-text.ts` keeps its readers — `parseWalletText`, `parseAndDecryptWalletText`,
`isWalletTextFormat`, `isTextWalletEncrypted`, `decryptTextFormatKey` are all still exported from
the package root. Deleting them would have made a backup the SDK still produces unrestorable.
Callers that used `Sphere.importFromLegacyFile` for `.txt`/mnemonic/JSON files should call
`parseAndDecryptWalletText` + `Sphere.import(...)`, or `Sphere.importFromJSON(...)`, directly.

**A `wallet.dat` blob handed to the surviving text parsers is refused loudly.**
`parseWalletText`/`parseAndDecryptWalletText` detect the `SQLite format 3` magic and return
`{ success: false, error: 'Bitcoin Core wallet.dat import is no longer supported…' }` instead of
the old vague "Could not find master private key in backup file" — the master key never silently
goes missing.

### Removed — the pre-E.4 (v:1) intent resume path

An intent payload is `v:2` and nothing else. The `v:1` shape stopped being written at the E.4
cutover (2026-07-05, #638); only an intent PUT between 2026-06-12 (when intents first shipped,
#502) and that date could still carry it, and those builds were the `0.9.1-dev.#`/`0.11.x` line
that only this program's own staging consumers ran.

Gone with it: the checkpoint-less split branch (re-deliver the journaled blob, change recovers via
inventory resync), the `SplitCheckpointLostError` "record the spend" case, and the conditional
checkpoint store — `resumeIntent` now always resumes a split THROUGH its burn checkpoint.

**A v:1 payload is now REFUSED rather than run down the v:2 path.** It has no checkpoint, so
resuming it would raise `SplitCheckpointLostError` (keep-open) and wedge the intent forever.
Refusing puts it in `resumeOpenIntents().failed` with the reason in the message, leaves the server
row OPEN and untouched, and executes nothing.

No wallet-api change: the server stores the payload as an opaque ciphertext envelope
(`payload bytea`, size-capped) and never parses it — `v` is a client-side contract end to end.


### Changed — state-transition-sdk 2.0.2 (was 2.0.1)

Upstream is one change (state-transition-sdk-js#138): token verification is now behind an
`ITokenVerifier` interface, with the sequential logic moved verbatim into a default
`TokenVerifier` and an OPTIONAL worker-backed implementation alongside it.
`InclusionProofVerificationRule.verify` takes a precomputed transaction hash + lockScript +
sourceStateHash instead of the transaction object (so a worker can verify without it), and
`RootTrustBase`/`RootTrustBaseNodeInfo` gain `toJSON()`.

**No wire change.** Diffing the published 2.0.1 and 2.0.2 builds: not one `toCBOR` implementation
differs — every changed file is verification plumbing. So split-checkpoint resume is unaffected
(its guard is byte-equality of the stored vs re-derived `TransferTransaction.toCBOR()`), and a
checkpoint written under 2.0.1 still rebuilds under 2.0.2. `CHECKPOINT_SDK_VERSION` (recorded for
drift DIAGNOSIS only) moves to `…@2.0.2` with the pin.

### Added — opt-in parallel token verification

Upstream's worker verifier is only useful if consumers can reach it, so it is now configuration:

```ts
const { sphere } = await Sphere.init({ ...providers, verification: { createWorker, poolSize: 4 } });
```

- `EngineConfig.verification` / `SphereInitOptions.verification` (also on the create/load/import
  options): `{ createWorker: () => VerificationWorker; poolSize?: number }`. Omitted → the
  sequential verifier, i.e. unchanged behavior. `VerificationWorker` is our own structural view of
  the web-`Worker` subset, payloads typed `unknown`, so no base-SDK wire type reaches the port.
- The worker ENTRY SCRIPT is the consumer's — only their bundler can emit a worker. Its predicate
  verifier must match the engine's or the verdict silently diverges from the sequential one; both
  sides using `PredicateVerifierService.create()` is safe. `docs/VERIFICATION-WORKERS.md` has
  runnable Node and browser scripts.
- `ITokenEngine.dispose?()` (new, optional) terminates the pool. Workers spawn LAZILY, so building
  an engine still costs nothing — which matters because Sphere rebuilds it on every address switch
  and api-key change.
- **Per-address engine lifecycle corrected while wiring that up.** Every tracked address builds its
  OWN engine, so with `verification` enabled each may own its own worker pool:
  - `_tokenEngine` now follows the ACTIVE address. It did not: a re-visit does not re-run
    `initializeAddressModules`, so the field kept naming whichever address was initialised last —
    and `setOracleApiKey()` then terminated THAT address's pool (while it kept running in the
    background) and leaked the active one's.
  - `setOracleApiKey()` rebuilds for the active address, updates that address's own module-set
    record (a stale entry would hand it a disposed engine on the next switch back), and disposes
    only the engine it actually replaced.
  - `destroy()` disposes EVERY per-address engine, not just the active pointer — a wallet that has
    visited three addresses was leaving three pools behind, which can keep a Node process alive.
- No worker module enters either bundle when unused: we import only the deep `lib/**` paths we
  already used (verified — `worker_threads` appears solely in the Node bundle's pre-existing
  undici/webidl code, identically under 2.0.1).


### Changed — `payments.sync()` is a flush; the IPFS-era merge machinery is gone

`sync()` once merged remote TXF state back into the wallet. Only the IPFS provider ever supplied
any. **All three remaining providers** — wallet-api, IndexedDB, file — implement `sync()` as
"save and return the input unchanged" (`added: 0, removed: 0, merged: localData`), so the merge
path had nothing to merge.

`sync()` is retained and still called by consumers, but it is now what it actually does: a write
to every configured provider. **The returned counts are always zero.**

Removed with it:

- `_doSync`'s merge application — address-mismatch rejection, merged-nametag restore,
  `parsedTokenCache` rebuild and merged-history import, all operating on data identical to what
  was sent.
- The push-sync path: `subscribeToStorageEvents`, `unsubscribeStorageEvents`,
  `debouncedSyncFromRemoteUpdate`, `storageEventUnsubscribers`. **No implementation has provided
  `TokenStorageProvider.onEvent` since IPFS was removed**, so this could never fire. The optional
  `onEvent` member is dropped from the port, along with the now-dead bridge in `core/Sphere.ts`.

**This also fixes a latent bug** the earlier analysis recorded: `syncDebounceTimer` was shared by
two debouncers doing *different* work — a storage-remote-update sync and an inventory wake resync
— so each cancelled the other, and `unsubscribeStorageEvents()` silently dropped a pending
inventory resync. With the storage-event debouncer gone the field has a single owner and is
renamed `inventoryDebounceTimer`.

**Also removed: the `sync:provider` event.** It reported per-provider merge counts that are now
structurally zero, and it had **no subscriber** — not in the SDK, not in the Sphere frontend. A
review caught the flush emitting `success: true` unconditionally even when a provider's `save()`
failed; deleting the event is the honest fix, since `storage:degraded` already reports an
active-provider failure.

**Fixed in review (P1):** `teardownDeliveryPump()` did not clear the inventory-wake debounce. The
only thing that used to clear it was `unsubscribeStorageEvents()`, removed here — so a wake
landing within the debounce window could survive `destroy()` and resync into a wallet whose token
map had just been cleared (`destroy()` leaves `deps` set), or cross an address switch. Now cleared
alongside the rest of the wake/poll teardown, with a test verified RED without the fix.

Three tests covering the merge path were deleted. The capabilities they touched survive on the
`load()` path and stay covered there: history import by
`PaymentsModule.history-sync.test.ts` ("should import `_history` entries from loaded TXF data")
and `PaymentsModule.history.test.ts` ("should migrate legacy KV history to new store on load");
nametag recovery by `PaymentsModule.test.ts` ("should recover nametags from storage on load()").
No test was weakened.

### Removed — the Nostr token-delivery rail

Assets ride the delivery port exclusively. `TransportDeliveryAdapter` (the fallback that wrapped
the Nostr relay in the delivery interface) is deleted, along with the `transport.onTokenTransfer`
subscription, `handleIncomingTransfer` (the Nostr envelope wrapper around the real ingest,
`handleV2Transfer`), and `receive()`'s `fetchPendingEvents` branch.

**Breaking:** a composition with no delivery provider can no longer send or receive assets.
`send()` and `receive()` throw `INVALID_CONFIG` with a message naming the fix, rather than
dereferencing null deep in the send path. Non-payment Sphere modules (DMs, group chat, market)
are unaffected and still initialize normally — the check is at the point of use, not at
`initialize()`.

Nostr is untouched as a rail for identity bindings, DMs and group chat. `transport.resolve` is
still how a recipient's chain pubkey is found, and `resolveTransportPubkey` still supplies history
metadata.

**Tests: 27 assertions across 6 files were translated, not weakened.** They asserted on the
`transport.sendTokenTransfer` mock; they now assert on the delivery port that actually carries
the token. The money-safety cases are unchanged in meaning — a post-certification delivery
failure still must not fail the sender (#621), the journaled blob still replays, and the
`transferId`/blob assertions still hold. A new `tests/support/memory-delivery.ts` provides a
minimal `DeliveryProvider` with failure injection; `multi-token-send` keeps its own clock-aware
one because it asserts delivery *timing*. Test count is unchanged at 3,113.

**Fixed in review (P1):** `load()` replayed the `PENDING_V2_DELIVERIES` journal unconditionally.
With no delivery provider composed — now an explicitly supported state — `attemptDeliveryWithBackoff`
dereferenced null, the failure was counted as a delivery attempt, and after
`MAX_DELIVERY_REPLAY_ATTEMPTS` the entry was marked `undeliverable`, permanently excluding
already-certified funds from auto-replay even once a provider was composed. The replay is now
guarded on `this.delivery`, mirroring the incoming pump five lines below it. Covered by a test
that is verified RED without the guard.

**Now dead, not removed here:** `TransportProvider.sendTokenTransfer` / `.onTokenTransfer` have
zero production callers. Removing them is a transport-layer change and gets its own PR.

### Removed — the archived / forked TXF token stores

Dead since the v1 removal. `archiveToken` calls `tokenToTxf`, which does `JSON.parse(sdkData)`;
a v2 token's `sdkData` is hex-of-CBOR, so the parse throws, `tokenToTxf` returns `null` and
`archiveToken` returns early. **No v2 token has ever been archivable**, so these maps could only
hold pre-cutover leftovers and nothing could add to them.

**Breaking — 8 documented public methods removed** from `PaymentsModule`
(`docs/API.md` "Methods: Archives" and "Methods: Forked Tokens" are deleted with them):
`getArchivedTokens`, `getBestArchivedVersion`, `mergeArchivedTokens`, `pruneArchivedTokens`,
`getForkedTokens`, `storeForkedToken`, `mergeForkedTokens`, `pruneForkedTokens`.

Every one had zero callers outside `PaymentsModule` except `getArchivedTokens`, which
`AccountingModule` used at 4 sites to scan `txf.transactions` for invoice attribution — a v1-only
structure that no v2 token carries. Those scans are removed too, so **accounting no longer reaches
into payments for archives**.

Also removed: `archiveToken` and its 5 call sites in `addToken`/`updateToken`/`removeToken`, the
`archivedTokens` / `forkedTokens` fields and their persistence in `createStorageData` /
`loadFromStorageData`, and four module-level helpers left with no callers —
`findBestTokenVersion`, `pruneMapByCount`, `isIncrementalUpdate`, `countCommittedTxns`.

Wallets carrying archived entries from the v1 era will drop them on the next save. Those entries
described v1 tokens, which have been unspendable since the cutover and undisplayed since the v1
removal.

No test changed: **not one test touched any of this** — which is also why it is worth stating that
the safety argument here is the `tokenToTxf` no-op above, not test coverage.

### Changed — accounting detached from payments; sends no longer carry on-chain memos

`PaymentsModule` no longer produces on-chain memos. `parseInvoiceMemoForOnChain` was the sole
producer, and it only ever encoded invoice-shaped memos — plain memos were already
transport-only. **Every memo is now transport-only.**

**Breaking:**

- `TransferRequest.invoiceRefundAddress` and `TransferRequest.invoiceContact` are removed.
- `PayInvoiceParams.refundAddress` and `PayInvoiceParams.contact` are removed. Both were
  documented as *"embedded in the on-chain TransferMessagePayload"*; with no on-chain message
  they were validated and then discarded. Removing them makes that a compile error rather than a
  silent no-op, and drops `INVOICE_INVALID_REFUND_ADDRESS` / `INVOICE_INVALID_CONTACT` from
  `payInvoice`'s failure modes.

**Functional consequence, stated plainly:** `AccountingModule` attributes an incoming invoice
payment by reading the on-chain memo (`engine.readMemo`). Nothing writes one any more, so
**recipient-side invoice attribution no longer works for new payments** — invoices will not
advance to PARTIAL/COVERED from inbound money, and `invoice:payment` / `invoice:covered` will not
fire for it. Attribution of payments sent *before* this change is unaffected. This is a
deliberate step in retiring accounting, not an oversight.

**Fully detached.** `modules/payments/` now imports nothing from `modules/accounting/`.
`IntentPayloadV1.invoiceRefundAddress` / `.invoiceContact` are gone and the resume path no longer
derives a memo.

The memo is an input to the transaction, so in principle a resume must rebuild byte-identical
data — an intent persisted with an invoice memo would otherwise match-verify against a different
transaction hash. That window is empty in practice: the only producer of an `INV:` memo is
`accounting.payInvoice`, whose sole in-repo caller is `SwapModule`, which the Sphere wallet does
not use (0 references). The Connect invoice intents are not enabled. The memo pattern requires
exactly 64–68 hex characters, so it cannot arise by hand. No shipped path can have created such
an intent.

Five tests covered removed behavior. One was re-pointed — the send path now asserts that **no**
memo reaches the chain, not even an invoice-shaped one, which is the whole contract. Four
`payInvoice` validation tests were deleted: they asserted runtime rejection of parameters that no
longer exist, and the type system now rejects them at compile time. No test was weakened.

### Removed — the Nostr payment-request channel

Payment requests ride wallet-api (sdk-changes S4). The Nostr fallback is gone, so
`PaymentsModule` no longer has two implementations of one concept.

**Breaking:** a composition without the wallet-api payment-request capability can no longer
send or receive payment requests. `sendPaymentRequest()` now returns
`{ success: false, error: 'Payment requests require the wallet-api payment-request capability' }`
instead of falling back to Nostr — an explicit refusal at the call site rather than a silent
no-op. `transport.onPaymentRequest` / `onPaymentRequestResponse` subscriptions are no longer
installed, and `sendPaymentRequestResponse` no longer has a transport leg.

Removed with it: `handleIncomingPaymentRequest`, `handlePaymentRequestResponse`, the
`unsubscribePaymentRequests` / `unsubscribePaymentRequestResponses` fields and their teardown.
`dispatchPaymentRequestResponse` stays — it is shared, and the wallet-api channel uses it.

This narrows the S7 covenant deliberately: payment requests are now wallet-api-only, while
storage and delivery remain swappable interfaces with contract suites. Nostr is untouched
elsewhere — it remains the rail for identity bindings, DMs and group chat.

**Also removed — two payment-request fields that the wallet-api path never carried.**
`PaymentRequest.recipientNametag` and `PaymentRequest.metadata` were only ever transmitted by the
deleted Nostr wire; `sendWalletApiPaymentRequest` forwards assets, the encrypted memo envelope and
`expiresAt` only. Leaving them declared would have meant a caller supplying them got `success:true`
with the values silently dropped. `IncomingPaymentRequest.recipientNametag` / `.metadata` are gone
for the same reason — `surfaceIncomingPaymentRequest` never set them, so they were permanently
`undefined`. Removing them turns a silent loss into a compile error.
`OutgoingPaymentRequest.recipientNametag` is unaffected — the wallet-api path still sets it.

One test was re-pointed, not deleted: `PaymentsModule.payment-requests.test.ts` previously
asserted "compositions WITHOUT wallet-api keep the Nostr payment-request path"; it now asserts
that no transport subscriptions are installed and that sending is refused with a wallet-api
error. No test was weakened.

### Removed — IPFS/IPNS token sync

Sphere syncs tokens through wallet-api. The IPFS rail was opt-in
(`tokenSync.ipfs.enabled`), off by default, and is gone: **-8,608 lines** across 42 files.

**Breaking:**

- The **`./impl/browser/ipfs` export subpath** is removed, along with
  `IpfsStorageProvider`, `createBrowserIpfsStorageProvider`, `createNodeIpfsStorageProvider`
  and every IPNS helper.
- **`tokenSync` is removed** from `createBrowserProviders` / `createNodeProviders`, as are
  `IpfsSyncConfig`, `NodeIpfsSyncConfig`, `NodeTokenSyncConfig`, `TokenSyncConfig` and the
  `ipfsTokenStorage` field on the returned providers. Its other backends (`file`, `cloud`,
  `mongodb`) were declared but never implemented and went with it.
- **Constants** `DEFAULT_IPFS_GATEWAYS`, `DEFAULT_IPFS_BOOTSTRAP_PEERS`, `UNICITY_IPFS_NODES`,
  `getIpfsGatewayUrls`, and `NetworkConfig.ipfsGateways`.
- **Dead config types** removed from the public surface (they reach consumers via
  `export * from './types'` but describe a constructor config `Sphere` does not accept, and had
  zero users): `SphereConfig`, `StorageProviderConfig`, `TransportProviderConfig`,
  `AggregatorProviderConfig`, `LoggingConfig`.
- **Dependencies dropped:** `ipns`, `multiformats`, `@libp2p/crypto`, `@libp2p/peer-id`
  (peer + optional + peerDependenciesMeta), and `@libp2p/bootstrap`, `@libp2p/interface` from
  devDependencies. The SDK's only remaining peer dependency is `ws`.

**Unchanged:** `TokenStorageProvider` stays a swappable interface with a shared contract suite —
only the IPFS implementation of it is gone. Nostr is untouched here; it remains the rail for
identity bindings, DMs and group chat. `sphere.payments.sync()` and the multi-provider merge
methods still exist and work against any storage implementation.

**Deferred:** `Identity.ipnsName` stays. It is a required field of the persisted TXF `_meta`
(`types/txf.ts`), so removing it is a storage-format change and gets its own PR.

One integration test was deleted rather than re-pointed: `tests/integration/history-sync.test.ts`
existed to drive `mergeTxfData` through a mock IPFS provider. Its non-IPFS property — history
read back from persisted TXF — remains covered by
`PaymentsModule.history-sync.test.ts` ("should import `_history` entries from loaded TXF data")
and `PaymentsModule.history.test.ts` ("should migrate legacy KV history to new store on load").
No test was weakened.

### Changed — compatibility-gate refusals now name the versions

A rejected handshake said `SDK version below the required minimum` and stopped there. The
numbers were in `error.data` all along, but every UI in the fleet renders `error.message` and
nothing else, so the one thing a developer needed — *which* version to move to — was the one
thing never shown.

- `checkCompatibility` now quotes both sides in `message`:
  `SDK version 0.11.9 is below the required minimum 0.12.0`,
  `Connect protocol 2.0 is below the required minimum 2.1`,
  `Incompatible Connect protocol version: app speaks 1.0, wallet speaks 2.1`.
  A client that sent no `sdkVersion` reads `SDK version unknown (not reported) is below …` —
  a distinct failure from an old version, and one a developer would otherwise chase in the
  wrong place.
- New `data.requiredProtocol` on a MINOR-floor refusal (the floor the wallet demands). The
  SDK floor already published `requiredSdk` / `actualSdk`; those are unchanged.
- Nothing else moved: same error codes, same `reason` values, same wire shape. Any UI that
  prints `error.message` gains the versions with no code change.
### Removed — the last v1 token remnants

The v2 cutover left v1 code paths behind to keep stored v1 TXF tokens *displayable*.
Those paths are now gone. Stored v1 tokens are unspendable (and have been since the
cutover); they are no longer parsed for display, no longer validated, and report as
`UNKNOWN` if surfaced.

**Breaking:**

- **`OracleProvider.validateToken()`** — removed from the interface and from
  `UnicityAggregatorProvider`. Token verification is entirely the engine's job
  (`engine.verify` + `engine.isSpent`). Custom `OracleProvider` implementations no
  longer need to supply it. The `ValidationResult` type it returned is removed with it,
  including its re-export from the root entry point. **This also deletes a latent data
  bug** rather than fixing it: `validateToken` caught *all* errors — including network
  failures — and returned `{valid: false}` instead of throwing, so a single gateway
  outage during `validate()` durably marked **every** stored v1 token `'invalid'` and
  persisted it, while the v2 branch fifteen lines above had an explicit
  "never invalidate funds on an outage" guard.
- With `validateToken` gone the oracle issues **no JSON-RPC calls at all** — it is now
  purely a network-config provider, as its own docstring already claimed. The internal
  `rpcCall`/`ensureConnected` plumbing and the spent-state cache are removed.

**Behavior:**

- `payments.validate()` is v2-only. A stored v1 relic is neither reported valid nor
  marked invalid — it is left untouched, because the engine cannot read it and guessing
  corrupts the user's view of their legacy holdings.
- `parseTokenInfo()` no longer contains the v1 TXF JSON display parser (this also
  removes a 37-line literal clone between its `genesis.coinData` and `state.coinData`
  branches).
- `load()` no longer terminalizes orphaned pending-V5 tokens into `'invalid'`; that
  migration ran on every load since the cutover and has served its purpose. The legacy
  `PENDING_V5_TOKENS` key is still dropped so it does not linger.

**Deliberately kept:** the non-blob key-derivation branch in `parseSdkDataCached`.
Despite reading the legacy JSON shape it is **not** a v1 feature — tombstone and journal
dedup are storage-level and version-agnostic, keyed by `(tokenId, stateHash)`, and the
tombstone suite covers both stored shapes on purpose. Removing it would have silently
weakened dedup in the money path.

**Also kept:** the archived/forked `TxfToken` stores. They look like v1 remnants but
have four live consumers in `AccountingModule` (invoice payment attribution) and no real
test coverage — they are Stage 10 of `docs/PAYMENTS-REFACTOR.md`, which requires
characterization tests first.

Verified: typecheck and lint clean, 210 test files / 3,329 tests green, and the **live
testnet2 e2e suite green** (6 files / 35 tests — including `payments-v2.testnet2` and
`token-engine.testnet2`), identical to the pre-change baseline.

### Removed — dead code in `PaymentsModule` (no behavior change)

Verified-unreachable code removed from `modules/payments/PaymentsModule.ts` (**7,179 → 7,025
lines**, −154). Every item was confirmed to have no reader repo-wide before deletion; the full
suite is green (213 files / 3,374 tests) and typecheck/lint/build are clean. Analysis and the
staged plan for the rest live in [`docs/PAYMENTS-ANALYSIS.md`](docs/PAYMENTS-ANALYSIS.md) and
[`docs/PAYMENTS-REFACTOR.md`](docs/PAYMENTS-REFACTOR.md).

**Breaking (public surface):**

- **`payments.getPendingTransfers()`** — removed. It always returned `[]`: nothing anywhere
  wrote `STORAGE_KEYS_ADDRESS.PENDING_TRANSFERS`, so the backing map was permanently empty. The
  storage key itself is retained (the wallet-clear and network-isolation suites assert on it).
- **`payments.waitForPendingOperations()`** — removed. Zero callers; `core/Sphere.ts` documents
  in a comment that address switching deliberately does *not* use it. The `pendingBackgroundTasks`
  array it drained was therefore an unbounded leak, and is removed with it.
- **`ProofPollingJob`** — removed. A v1 NOSTR-FIRST relic with no referent since the v2 cutover;
  it reached consumers only via `export *`, never named in the root entry point.
- **`payments.send(request, internal?)`** — the undocumented second parameter is gone.
  `existingReservationId`/`existingSplitPlan` existed only for `instantSplitSend`, deleted in the
  v1 cutover; nothing passed it, so both `existingSplitPlan === undefined` guards in the #625/#677
  re-plan loop were constant-true and are simplified away.

**Internal:** the write-only transfer OUTBOX (`saveToOutbox`/`removeFromOutbox`/`loadOutbox`) is
removed — it was never replayed (recovery runs off `PENDING_V2_DELIVERIES`), so it cost three
storage round-trips per send for nothing. The `_outbox` TXF storage field is unrelated and
unchanged. Also removed: `reloadNametagsFromStorage`, `createTombstoneFromToken`, a local
`fromHex` duplicating `core/crypto.hexToBytes`, and an unused `ParsedTokenPool` import. One test
asserting the deleted outbox lifecycle was removed (`PaymentsModule.tokenTransfers.test.ts`); no
test was weakened.

### Added — `ERROR_CODES.INTENT_OUTCOME_UNKNOWN` (4201), and a rule about what a host may claim

**Read this before upgrading if your dApp spends.** Once `onIntent` has been called, a host may
report the intent's RESULT or that the OUTCOME IS UNKNOWN. It may never assert that nothing
happened — it is not the party that knows.

Previously it did. The host's intent deadline was shorter than `ConnectClient`'s own timeout, so
the host was always first to give up, and it gave up with `INTENT_CANCELLED` (4200) — "the user
declined and nothing happened". The clock included the human's decision time, so confirming at
80 s meant the transfer was already on the wire when the deadline fired at 90 s; the real result
was then dropped. `setLocked()` / `revokeSession()` / `setUnavailable()` had the same shape,
settling a delegated intent with 4009 (whose documented advice is "retry after
`wallet:unlocked`") or 4001. Either one, on a spend the wallet had already submitted, is a
paid-but-not-credited order and a **double spend on the natural retry**.

- **`INTENT_OUTCOME_UNKNOWN` (4201)** — the intent reached the wallet and the answer was lost.
  **Do not retry**; reconcile out of band, then decide. Emitted by the host on a deadline, a
  lock, a logout or a teardown, and by `ConnectClient` for its own intent timeout and for a
  disconnect while an intent is pending.
- The host intent deadline is now **longer** than the client's, so the host is never the first to
  give up. If you pass `intentDeadlineMs`, keep it above your `intentTimeout`.
- A wallet answering an accepted intent with `WALLET_LOCKED` or `NOT_CONNECTED` is downgraded to
  4201: both describe the CHANNEL and say nothing true about the spend. `USER_REJECTED` is
  **not** downgraded — a decline before submission is a real, retryable rejection, and it is the
  wallet's job not to offer a cancel control once the transfer is on the wire.
- `WALLET_LOCKED` (4009) stays retryable for **queries**. Its "retry after unlock" advice was
  never safe for an intent.

### Added — graceful wallet lock (Connect protocol `2.0` → `2.1`)

A wallet lock used to destroy the dApp session: every request after it answered
`NOT_CONNECTED` (4001), and in iframe mode the host object itself was torn down, so a dApp
either hung for its full client timeout or disconnected. A lock is now a **state, not a
teardown** — the session survives it.

- **`ERROR_CODES.WALLET_LOCKED` (4009)**, carrying `data: { reason: 'locked' }`. Discriminate on
  the code, never on the message text.
- **Three new wallet events**, all auto-pushed and no longer subscribable:
  `wallet:unlocked` (carries the current identity), `wallet:disconnected` (the teardown signal —
  `revokeSession()` previously sent nothing at all, so a dApp only learned it was disconnected at
  its next 4001), and `wallet:locked` keeping its name. `sphere_subscribe` on any of the four
  answers success WITHOUT attaching them to `Sphere.on()` — the host pushes them unconditionally,
  so "you are subscribed" is true, and attaching them would be the bug (`Sphere.on()` accepts any
  string and never emits for these). The unlock edge also still pushes `identity:changed`, which
  the Connect 2.0 docs named as the only unlock signal.
- **`SphereHandshake.locked` / `ConnectResult.locked`** — a resume with a matching `sessionId`
  succeeds while the wallet is locked, which is the common case of a dApp that reloaded mid-lock.
- **`ConnectHost.setLocked()` / `.setUnavailable()` / `.getState()` / `.walletState`** — the
  wallet-binding axis is now explicit and orthogonal to the session.
- **`ConnectHostConfig.origin` / `.onLockedRequest` / `.initialWalletState` /
  `.requestDeadlineMs` / `.intentDeadlineMs` / `.handshakeDeadlineMs`.** `onLockedRequest` is
  notify-only and must never raise a credential surface: a dApp request may trigger a *consent*
  prompt, never a password field.
- **`onIntent` gains a 4th argument** (`IntentContext`) with the host deadline and an
  `AbortSignal`. The wallet must dismiss its modal on abort, otherwise the host's own deadline
  manufactures the double-submit it exists to prevent.
- **`ConnectClient.walletProtocol` / `.walletLocked`.** A Connect 2.0 wallet never emits
  `wallet:unlocked`, so a dApp waiting for one against an old wallet waits forever —
  `walletProtocol` is how you feature-detect.

### Fixed

- **Every accepted request is now answered exactly once.** A request in flight when the wallet
  locked answered `-32603` with a raw JS message, `sphere_getIdentity` returned `undefined` **as
  success** (which a dApp reads as "the wallet has no identity"), and a delegated intent whose
  `onIntent` threw was never answered at all — the throw reached `handleMessage`'s catch, which
  logged and sent nothing, so the dApp hung for its full `intentTimeout`.
- **Internal JS error text no longer crosses into a third-party dApp.** Only our own
  `SphereError` messages are forwarded (they are DX); anything else becomes a fixed string.
- **`updateSphere()` re-arms subscriptions.** It re-subscribed only `identity:changed`, and it is
  also the address-switch path — so a plain address switch already killed every
  `sphere_subscribe` stream a dApp held, permanently, because `ConnectClient.on()` fires the
  subscribe once and never retries.
- **The intent and handshake paths are rate-limited.** `checkRateLimit()` was reachable only from
  the query path, leaving the money path and the approval-UI path unmetered.
- **A cold-start-locked host no longer answers `INCOMPATIBLE_NETWORK` (4008) to every origin**
  with `walletNetwork { id: -1 }` — a leak to an unapproved origin, and a lie about the cause.
- **`Sphere.destroy()` zeroes `_mnemonic`, `_masterKey` and `_password`** and the three key
  getters are guarded by `ensureReady()`. It cleared `_identity` only, which made the wallet's own
  "keys leave memory" comment false. `Sphere.encrypt()` now fails **closed** for a
  password-protected wallet instead of silently rewriting an encrypted record as plaintext, and
  `PaymentsModule.destroy()` clears its token cache — a destroyed module kept answering balance
  queries.
- **`connect/version.ts` is pinned to `package.json` by a CI step that runs before the build.**
  The file is regenerated by `prebuild`, so any check placed after the build inspected the
  repaired copy and could never catch a committed-stale `SDK_VERSION` (it was `0.11.15` against
  `package.json` `0.12.0`).

### Behaviour changes

Two things a dApp can observe. Neither breaks an old dApp — a Connect 2.0 client that tears its
connection down on `wallet:locked` behaves exactly as it does today — but both are visible:

- **`wallet:locked` changed meaning.** It used to be followed by a revoked session; the session
  now survives. A dApp that disconnects on it still works, but disconnects unnecessarily and
  orphans a live host-side session until its TTL.
- **`sphere_disconnect` now works while locked.** It previously answered 4001, and the client
  swallowed that and cleaned up anyway — so `config.onDisconnect`, the only hook that revokes a
  persisted origin approval, never fired, and the next silent `autoConnect` reconnected with no
  prompt.

`notifyWalletLocked()` is **removed, not aliased**: its old meaning was *revoke* and its new one
would be *lock*, so an alias would be a silent runtime inversion at every wallet call site.
`CONNECT_MIN_SDK_VERSION` does not move.

Two more a wallet integrator should know:

- **The locked → live edge fails closed.** It revokes instead of unlocking when the returning
  wallet's `chainPubkey` differs from the one frozen at lock time, when either side is UNKNOWN
  (an absent identity is not evidence of sameness — and calling `sphere.destroy()` before
  `setLocked()` manufactures exactly that), or when the `networkId` changed. A spurious revoke
  costs a re-handshake, which is silent for an already-approved origin; the alternative is
  handing a preserved session to a different wallet or a different chain.
- **`PostMessageTransport` pins the peer WINDOW**, not just the origin, in both directions. An
  injected same-origin iframe passes any origin allow-list, and wallet event frames now decide
  the client's authoritative identity. `targetOrigin` is normalised with `new URL(...).origin`,
  so passing a full wallet URL (with a path, or a trailing slash) works.

### Changed — state-transition-sdk 2.0.1 (was 2.0.0-rc.68bc1e5)
- **Base SDK bumped to the stable `@unicitylabs/state-transition-sdk@2.0.1` release** (37 commits
  past the rc pin). Token verification/realization now goes through the SDK's shared
  `VerificationContext` (carried in `EngineDeps`); `StateMask` is a typed class (the HKDF-derived
  realization bytes are wrapped via `StateMask.fromBytes`, determinism unchanged); the split model
  binds each output's FULL payment payload (`SpherePaymentData`, memo included) into the
  allocation proofs — output token type is inherited from the source, no longer chosen per
  request. Split checkpoint records `…@2.0.1` as its wire-governing SDK version (an rc-era
  checkpoint resumes as a LOUD `SplitCheckpointLostError` byte-drift, by design).
- **Token issuance verification is fail-closed upstream (2.0.1, state-transition-sdk-js#137):**
  `TokenIssuanceVerifierService` now rejects any token whose type has no registered issuance
  verifier, and `VerificationContext` no longer defaults its verifiers — all must be passed
  explicitly. Sphere token types are generated per token (`TokenType.generate()`), so there is no
  fixed type to register a policy for; the engine constructs its context with an explicit
  `new TokenIssuanceVerifierService(false)` (the same opt-out upstream's own examples use).
  Verification behavior is unchanged.
- **Value-model contract tightened (upstream):** asset amounts must be strictly positive and a
  payment collection holds 1..256 assets — `SpherePaymentData` rejects zero/empty loudly
  (`VALIDATION_ERROR`). `AggregatorClient` now refuses an API key over plaintext `http://`.

### Removed
- **Self-issued `UnicityIdToken` mint** (`createUnicityIdMinter`, `token-engine/unicity-id.ts`):
  upstream deleted the unicity-id/nametag primitive in 2.0.0 (state-transition-sdk-js#132), so the
  best-effort on-chain claim minted at nametag registration is gone. Runtime behavior is
  unchanged — name resolution was already Nostr-binding-only and the stored token was never
  consumed. Stored `NametagData` entries remain readable.

### Fixed — heavy-wallet request storm (#642)
- **`PaymentsModule.load()` is single-flight:** the 30s inventory poll backstop and the
  `inventory` wakes funnel into `load()` via `resyncInventory()`; on a wallet whose load outlives
  the poll interval, uncoalesced calls stacked concurrent full loads — each with its own complete
  history hydration. Same-owner concurrent callers now share the in-flight load (plus exactly one
  trailing re-run so a wake that raced a load still converges); a different-owner call (re-init
  mid-load) serializes behind the stale load and runs fresh.
- **Incremental history hydration:** after one completed hydration per owner, later pulls page
  newest-first only until the first non-empty page with nothing new, and MERGE into the cache
  (also preserving local entries whose §10 POST hasn't landed yet). Before, every resync
  re-paginated from page 0 — on a wallet whose history overflows `MAX_HISTORY_HYDRATION_PAGES`
  that was 100 `GET /v1/history` pages every 30 seconds, forever (measured: 2,646 requests in
  8 minutes from one idle tab, 84% history pages). A pull cut off by the page cap still replaces
  the cache (merging would hide the gap).
- **Per-request timeout in the wallet-api client:** `WalletApiClientConfig.requestTimeoutMs`
  (default 30 000 ms, `0` disables; plumbed through `WalletApiCompositionConfig`). A stalled
  request aborts via `timeoutSignal()` (the #617 older-WebView guard, NOT bare
  `AbortSignal.timeout`) and surfaces as the transient `NETWORK` class, so the #630 retry policy
  applies unchanged (GETs retry, writes don't). Without it, requests starved by a connection-pool
  pile-up hung indefinitely and eventually failed the background token-storage save — the
  `storage:degraded` red-toast storm. Blob transfers and the wake socket are not governed by
  this timeout.

### Added
- **wallet-api client resilience (#630):** the §16 REST client now rides out transient failures
  instead of surfacing them raw. Idempotent GETs retry a dropped/reset connection (a DNS /
  `ENOTFOUND` blip) with bounded exponential backoff **+ full jitter**; a `429` retries on any
  method and a `503` on GETs, both honoring the server `Retry-After` (capped). Tunable via
  `WalletApiClientConfig.retry` / `WalletApiCompositionConfig.retry` (default-on; `false` disables).
  The three background pumps (mailbox, payment-requests, inventory) no longer dump a full
  `WalletApiError` stack every 30 s tick during an outage — a transient network failure is a single
  `debug` line, escalating to one `warn` only after several consecutive failures, with a recovery
  line when it clears; non-network faults stay loud and immediate. Adds `WalletApiRetryConfig` and
  `HeadersLike`; extends `FetchResponseLike` with an optional `headers` accessor. `payments.send`
  transient-failure safety is unchanged — a wallet-api NETWORK error never re-mints a `transferId`;
  same-`transferId` E.2 resume already covers it.
- `parseTokenAmount(value, decimals)` / `safeParseTokenAmount(value, decimals)` — strict
  human-readable → smallest-units parsing with ethers `parseUnits` semantics. `parseTokenAmount`
  throws `SphereError('INVALID_AMOUNT')` on empty/non-string input, non-decimal strings (sign,
  scientific notation, hex), and fractional digits exceeding `decimals` (no silent truncation);
  `safeParseTokenAmount` returns `null` instead of throwing (for live UI input). Adds the
  `INVALID_AMOUNT` error code.

### Removed
- **BREAKING:** Removed `toSmallestUnit` — it silently returned `0n` on invalid input and
  truncated excess precision (a money-safety footgun). Use `parseTokenAmount` (strict) or
  `safeParseTokenAmount` (UI input). Display helpers `toHumanReadable` / `formatAmount` are unchanged.
- **BREAKING:** Removed the entire L1 (ALPHA blockchain) layer — `sphere.payments.l1`, the `L1` namespace, `L1Config`, `identity.l1Address`, the `sphere_l1GetBalance` / `sphere_l1GetHistory` Connect queries, the `l1_send` intent, and the `l1:read` / `l1:transfer` permission scopes. Wallets are now L3-only.

### Fixed — history disappears on reload (#549)

- **History reload (#549, the HISTORY twin of #521):** in the wallet-api
  composition `PaymentsModule.loadHistory()` read from the local token storage
  provider's `getHistoryEntries()`, but the thin `WalletApiTokenStorageProvider`
  keeps no history — so a reloaded instance (tab refresh) fell into an empty KV
  fallback and rendered an empty transaction history, even though every send /
  receive POSTs the record to the server's §10 log. `loadHistory()` now rebuilds
  `_historyCache` from `walletApi.listHistory()` (newest-first keyset pages until
  `more:false`, deduped by `dedupKey`) whenever the `walletApi` client is
  present; the S6 `memo` / `counterpartyNametag` envelopes are decrypted with the
  owner's own field key on read-back (§8.3). Compositions without `walletApi`
  keep the legacy local path. The `PaymentsWalletApiPort` gains a `listHistory`
  member (the READ side of the §10 client-written log). Regression: send→reload
  (SENT record, memo decrypted) and receive→reload (RECEIVED record, sender
  nametag + memo decrypted) against the fake backend, asserting the in-session
  and post-reload sets match (no loss, no dupes).

### Fixed — reload renders an empty wallet (#521)

- **Thin-provider reload (#521):** `WalletApiTokenStorageProvider` persisted
  its inventory cursor durably while the item view lived only in process
  memory, so a reloaded instance (tab refresh) delta-synced from the warm
  cursor into an empty view and rendered an empty wallet. The first sync of
  each instance/identity session is now always a full pull (both `load()`
  entry paths and the lazy-view merge benefit); deltas resume within the
  session.

### Fixed — incident 2026-06-12 hardening (#515, #516)

- **Fail-closed composition invariant (#515 F1):** wallet-api CUSTODY
  artifacts (the thin `WalletApiTokenStorageProvider`, delivery custody
  `'inventory'`) composed without the `walletApi` client now throw
  `INVALID_CONFIG` at `PaymentsModule.initialize`/`Sphere.init` instead of
  silently running local-custody semantics. `TokenStorageProvider` gains an
  optional `requiresWalletApi` marker. `Sphere.init` now forwards the
  `delivery`, `walletApi` and `communications` options to
  `Sphere.create`/`Sphere.load` — previously they were silently dropped.
- **Checked SaveResult (#515 F2):** `PaymentsModule` now checks
  `SaveResult.success` of the ACTIVE custody provider. User-facing flows
  (mint, the send pipeline's custody writes) fail loudly (`STORAGE_ERROR`);
  background saves emit the new `storage:degraded` event.
- **Surfaced wallet-api session state (#515 F3):** a failed sign-in is
  recorded (readable via `sphere.walletApiSessionStatus`) and emitted as the
  new `walletapi:session` event (`'offline'`/`'online'`); boot stays
  non-blocking.
- **Double-pay hazard (#516):** `WalletApiClient.abortIntent` flips the LOCAL
  intent copy to `'aborted'` even when the server abort cannot land (dead
  backend); the unlanded abort is replayed by `resyncOpenIntents`
  (PUT + abort), so a send that failed at `putIntent` can never be re-executed
  by `resumeOpenIntents` after reconnect.

### BREAKING — v1 state-transition-sdk removed (v2 engine cutover)

The legacy `@unicitylabs/state-transition-sdk@1.6.1-rc` engine is gone. The
canonical package name now resolves to the v2 SDK (pinned `2.0.0-rc.6027e82`),
consumed exclusively through the `token-engine/` port. Consequences:

- **The token engine is mandatory for money movement.** `send()`,
  `mintFungibleToken()`, `accounting.createInvoice()/importInvoice()` fail
  loudly (`AGGREGATOR_ERROR` / `INVOICE_ORACLE_REQUIRED`) when the oracle does
  not supply a v2 trust base + gateway URL. Recipients must have a published
  chain pubkey (`INVALID_RECIPIENT` otherwise).
- **Removed public API:** `payments.sendInstant()`, `payments.resolveUnconfirmed()`,
  instant-split/payment-session wire types (`types/instant-split`,
  `types/payment-session`), transport `sendInstantSplitBundle`/`onInstantSplitReceived`,
  oracle `submitCommitment`/`getProof`/`waitForProof`/`isSpent`/`getTokenState`/
  `getCurrentRound`/`mint`/`getStateTransitionClient`/`getAggregatorClient`/
  `waitForProofSdk` (+ their commitment/proof/mint types).
  `ReceiveOptions` finalization options are deprecated no-ops (v2 tokens arrive
  finished — there is no finalization phase).
- **Wire compatibility:** the only supported transfer payload is `V2_TRANSFER`
  (a finished v2 token blob). Incoming v1 payloads (V5/V6 instant-split,
  NOSTR-FIRST, `{sourceToken,transferTx}`, plain token JSON) are dropped with an
  explicit error log — peers must run a >=0.8 wallet to send to this wallet.
- **Incoming v2 transfers are now verified** (`engine.verify` + ownership check
  against this wallet's chain pubkey) before entering the balance; `validate()`
  checks v2 tokens via the engine (`verify` + `isSpent`).
- **Stored v1 TXF tokens** stay visible (parsed as plain JSON for display) but
  are unspendable — there is no migration path through the removed v1 engine.
  Orphaned pending-V5 tokens are terminalized to `invalid` on load (data kept).
  Legacy v1 TXF invoices are rejected on import with an explicit error.
- **`NETWORKS.testnet` now points at testnet2** (the v2 gateway network,
  networkId 4, own token registry); `testnet2` stays as an alias. `mainnet`/`dev`
  still point at v1-era aggregators — wallet operations there fail loudly until
  those gateways are cut over to the v2 protocol.
- **`AccountingModuleDependencies.trustBase` removed** (the engine owns trust);
  `accounting.importInvoice` accepts the v2 invoice blob (hex string);
  `CreateInvoiceResult.token` is now that hex blob `string` (was the v1
  `TxfToken` object type).
- **Oracle interface gains three REQUIRED members** the v2 engine is built
  from: `getTrustBaseJson()`, `getAggregatorUrl()`, `getApiKey()` — custom
  `OracleProvider` implementations must provide them.
- **Send-failure money-safety:** finished-but-undelivered transfer blobs are
  journaled (`PENDING_V2_DELIVERIES`) and replayed on `load()`; sources
  certified on-chain during a failed send become terminal `'spent'` (never
  restored to `'confirmed'`); tokens stuck `'transferring'` after a crash are
  reconciled against the network on `load()`.
- **Unicity ID on-chain claim is minted + stored at nametag registration**
  (`registerNametag`, init/load recovery, address switch): a self-issued v2
  `UnicityIdToken` saved as `NametagData { format: 'v2-cbor', token: <hex> }`
  (`NametagData.token` widened to `object | string`). Best-effort + idempotent —
  a gateway outage never fails registration; runtime name resolution stays
  Nostr-binding-only. On networks without a v2 oracle config a warn is logged
  on each load. New exports: `createUnicityIdMinter`, `IUnicityIdMinter`,
  `UnicityIdMintResult` (token-engine).

### Added
- **Thin-wallet core (wallet-api program, sdk-changes S1/S2/S6/S7)** —
  - **`WalletApiClient`** (new `wallet-api/` module + `./wallet-api` subpath export): challenge→sign→JWT auth with mandatory challenge-template verification (`unicity:wallet-api:auth:v1\n` prefix, own-pubkey + plausible-timestamp checks — the spend key never signs unverified server text), rotating refresh tokens (`v1.<sessionId>.<secretHex>`) with rotation-reuse-revocation fallback to a fresh challenge cycle, logout; typed REST for the §16 inventory/intents/blob endpoints (amounts are decimal strings on the wire, `bigint` in types); WS wake channel via the single-use ticket flow; refresh token kept only in injected storage (never logged); non-loopback base URLs must be `https:`. The client keeps the normative LOCAL copy of open intents (E.3) and re-PUTs them on a `syncEpoch` change.
  - **S6 field encryption** (`core/field-encryption.ts`): `deriveFieldEncryptionKey` = HKDF-SHA256(wallet privkey, `sphere-fieldenc-v1`); XChaCha20-Poly1305 envelopes `"enc1." + base64(nonce ‖ ciphertext)`; `assertFieldEnvelopeShape` is the server-side prefix/base64/size-cap check (ARCHITECTURE §8.3). New dependency `@noble/ciphers`.
  - **S2 lazy storage port**: `TokenStorageProvider` gains `listInventory(since?)` (value view, tombstone deltas, no blobs), `getToken(tokenId)` (on-demand blob fetch) and `applyDelta(transferId, spent, added, opts?)`; `WholeBlobInventoryAdapter` derives all three from `load()`/`save()` so every existing whole-blob provider (File/IndexedDB/IPFS) conforms unchanged.
  - **`WalletApiTokenStorageProvider`** (impl/shared, platform-neutral): tombstone-aware delta sync with `more` loops, paginated full pull closed by a `?since=<page-1 cursor>` delta, `syncEpoch`-change handling (discard cursors → full pull → re-PUT open intents), write-behind with empty-import protection (a fresh device or failed load never pushes removals; only confirmed-spend tombstones do), `recoverRemoved()` (re-fetch + locally verify + reactivate wiped tokens; server 409 = actually spent), content-addressed blob upload (412 = already present = success).
  - **S7 storage contract suite** (`tests/contract/storage-provider.contract.ts`): one shared suite run against both `FileTokenStorageProvider` (via the default adapters) and `WalletApiTokenStorageProvider` (against `tests/support/fake-wallet-api.ts`, an in-process §16 fake whose every behavior cites its ARCHITECTURE section).
- **Delivery port + mailbox + composition (wallet-api program, sdk-changes S2-consumer/S3/S4/S7)** —
  - **`DeliveryProvider` port** (`transport/delivery-provider.ts`, exported from the root barrel): `deliver(recipientPubkey, blob, { transferId, memo? }) → { deliveryId }` (idempotent per (token, state)), `incoming(sinceCursor?)` AsyncIterable of `{ deliveryId, transferId?, senderPubkey?, memo?, fetchBlob(), cursor }` (+ optional `onWake` hook), `ack(deliveryId, 'claimed' | 'rejected')`. `deliveryId` is CONTENT-DERIVED — `hex(SHA-256(tokenId bytes ‖ stateHash bytes))`, the backend's entry_id formula (`computeDeliveryId`/`deliveryKeysFromBlob` helpers) — never a server row id. Custody (`'inventory' | 'external'`) is a composition-time constructor property, never a per-call flag; implementations keep a persistent (tokenId, stateHash) seen-set as the recipient-side replay guard.
  - **`WalletApiMailboxProvider`** (impl/shared, the S3 reference implementation): deliver = sha256 + upload-urls upload (412 = already present = success) → idempotent `POST /v1/mailbox` with the entryId verified content-derived; memos S6-encrypted before they leave the device (decrypted on incoming when the wallet key matches); incoming = `GET /v1/mailbox?since=` paging with pending-only filtering, `blobCollected` handling and byte-level re-verification of fetched blobs; ack = claim with the provider's custody (`'external'` always sends `intoInventory:false`) or reject (terminal for discovery only).
  - **`WalletApiClient` mailbox + history endpoints**: `depositMailbox`, `listMailbox`, `claimMailbox`, `rejectMailbox`, `postHistoryRecords`, `listHistory` (§6/§10/§16; decimal-string amounts, S6 envelopes verbatim).
  - **PaymentsModule rewiring (S2 consumer + S3)**: balances/coin-selection read the storage port's `listInventory()` view as LAZY records (zero blob downloads; `Token.lazy`); the send path runs awaited `putIntent` (E.3) → `getToken()` only for the SELECTED sources → engine transfer/split seeded by ONE per-send `transferId` → journaled `deliver()` through the delivery port (the `transport.sendTokenTransfer` V2_TRANSFER leg is gone; without a composed port a `TransportDeliveryAdapter` preserves the relay path through the same seam) → one `applyDelta` carrying the send's transferId (inventory-custody compositions) → `completeIntent` (uniform E.3 close) → dedupKey'd `POST /v1/history` with S6-encrypted memo/nametag. The `PENDING_V2_DELIVERIES` journal + replay-on-load now point at the port (the journal records the recipient's CHAIN pubkey). Incoming deliveries feed the existing transport-agnostic `handleV2Transfer` from `incoming()` (poll + wake + one-shot `receive()`); local-verification failures `ack('rejected')` and surface as the new **`transfer:invalid`** event. New public `resumeOpenIntents()` re-runs open intents deterministically (conflicts abort per E.2). SpendQueue/TokenReservationLedger and the Nostr DM/group-chat/nametag paths are untouched.
  - **S4 composition** (impl/shared/wallet-api): `createSphereProviders(base, { storage, delivery, engine })` selects each port independently; `createWalletApiProviders` = the full preset (thin storage + mailbox custody `'inventory'`); `createOwnStorageWalletApiProviders` = delivery-only (app storage keeps custody; mailbox custody `'external'` baked in). `Sphere.init`/`create`/`load`/`import` accept `delivery` + `walletApi`; the auth lifecycle is wired (sign-in on unlock, logout on account switch, open-intent resume at sign-in).
  - **S7 delivery contract suite** (`tests/contract/delivery-provider.contract.ts`) run against `WalletApiMailboxProvider` in both custody modes, plus fake-server §6/§16 mailbox semantics (deposit idempotency incl. recipient/key-mismatch 409, caps 429, claim handoff/alreadyClaimed/upgrade/failed bucket, reject-stays-claimable, read pointer, blobCollected) and §10 history.
- **Payment requests ride wallet-api (wallet-api program, sdk-changes S4 — backend M4)** —
  - **`WalletApiClient` payment-request endpoints** (§10/§16): `createPaymentRequest` (payer auto-provisioned; per-payer open cap → 429; `expiresAt` sent ISO-8601), role-aware `listPaymentRequests` — incoming = the payer's gap-free `?since=<seq>` stream (bigint cursor, the standard §16 since contract), outgoing = the requester's newest-first `?before=<opaque keyset>` backfill (string|null cursor); the two cursor families are unrepresentable to mix client-side — and `respondPaymentRequest` (`{action:'paid', transferId}` required pair / `{action:'declined'}` forbids it; addressee-only 403, open-only 409). Amounts decimal strings ⇄ `bigint`; the memo is the S6 `enc1.` envelope verbatim (encrypt before calling — it decrypts only under the requester's wallet key).
  - **PaymentsModule path selection (covenant §3.1-6)**: when the composed `walletApi` port carries the payment-request capability (the S4 presets), `sendPaymentRequest`/reject/pay flow through the §16 endpoints with the memo S6-encrypted client-side, and the Nostr payment-request subscriptions are NOT installed; without it the transport path is untouched. Incoming requests are discovered by polling the `?since=` seq stream (new public `syncPaymentRequests()`; cursor persisted per network+identity like the mailbox cursor; `syncEpoch` change → re-pull from 0 with id-dedup; a restarted module recovers still-open requests via a `status=open` bootstrap scan) and surfaced through the existing handler/event surface. `payPaymentRequest` links the fulfilling send via `respond(action:'paid', transferId)`; `rejectPaymentRequest` maps to `action:'declined'` and is server-confirmed BEFORE the local flip (403/409 propagate); `acceptPaymentRequest` stays a local UI state (the backend models open → paid|declined|expired only). Outgoing responses fold in from the `?before=` backfill (requester sees paid/declined/expired; `waitForPaymentResponse` resolves).
  - **Fake backend M4 contract** (`tests/support/fake-wallet-api.ts`): per-payer gap-free seq + payer auto-provisioning, role views with the real wire shapes (seq/cursor/syncEpoch as JSON numbers, per `src/payments/service.ts`), role × cursor mixing → 422 `VALIDATION_FAILED`, respond semantics 403/404/409/422, per-payer open cap → 429 `QUOTA_EXCEEDED`, `expireDuePaymentRequests()` server-owned-expiry hook.
- **`cacheMessages` option for CommunicationsModule** — `communications: { cacheMessages: false }` in `SphereInitOptions` disables DM caching in memory and storage. Messages still flow through `onDirectMessage()` handlers and `message:dm` events, but are never stored. Useful for anonymous/ephemeral agents (e.g. LLM bots) that only need streaming DM reception. `sendDM()` still works but doesn't cache the sent message. Deduplication is skipped when caching is disabled.
- **Message signing** — `signMessage()`, `verifySignedMessage()`, `hashSignMessage()` crypto functions for secp256k1 ECDSA with recoverable signatures (Bitcoin-like double-SHA256 with `Sphere Signed Message:\n` prefix). `Sphere.signMessage(message)` instance method encapsulates private key access. `SIGNING_ERROR` added to `SphereErrorCode`. `SphereInstance` interface in ConnectHost extended with `signMessage`. 22 unit tests covering signing, verification, round-trips, tampering detection, and edge cases.
- **Centralized logger** — `logger` singleton with `debug`/`warn`/`error` levels, `globalThis`-based state sharing across tsup bundles, per-tag control (`logger.setTagDebug('Nostr', true)`), and custom handler support
- **`SphereError` with typed error codes** — All SDK methods throw `SphereError` with a typed `.code` field (`SphereErrorCode`). 15 error codes: `NOT_INITIALIZED`, `ALREADY_INITIALIZED`, `INVALID_CONFIG`, `INVALID_IDENTITY`, `INSUFFICIENT_BALANCE`, `INVALID_RECIPIENT`, `TRANSFER_FAILED`, `STORAGE_ERROR`, `TRANSPORT_ERROR`, `AGGREGATOR_ERROR`, `VALIDATION_ERROR`, `NETWORK_ERROR`, `TIMEOUT`, `DECRYPTION_ERROR`, `MODULE_NOT_AVAILABLE`
- **`isSphereError()` type guard** — Helper function for typed error handling in catch blocks
- **Silent failure logging** — All previously silent `.catch(() => {})`, empty catch blocks, and timeout-based silent failures now log via `logger.warn` (operational issues) or `logger.debug` (expected/non-critical)
- **20 unit tests** for logger module
- **IPNS push-based sync via WebSocket** — `IpnsSubscriptionClient` connects to `/ws/ipns` on IPFS gateways for real-time IPNS update notifications, with exponential backoff reconnection (5s→60s capped) and 30s keepalive pings
- **Fallback HTTP polling** — When WebSocket is unavailable, the IPFS provider automatically polls for IPNS changes at a configurable interval (default: 90s)
- **Auto-sync on import** — `Sphere.import()` automatically syncs with all registered token storage providers after initialization to recover tokens from IPFS
- **Debounced auto-sync on remote updates** — `PaymentsModule` subscribes to `storage:remote-updated` events from token storage providers and performs a debounced (500ms) sync, emitting a new `sync:remote-update` sphere event
- **`storage:remote-updated` storage event type** — New event emitted by `IpfsStorageProvider` when a remote IPNS change is detected via WebSocket push or HTTP polling
- **`sync:remote-update` sphere event** — New top-level event with `{ providerId, name, sequence, cid, added, removed }` payload, emitted after a push-triggered sync completes
- **WebSocket factory injection in platform factories** — `createNodeIpfsStorageProvider()` and `createBrowserIpfsStorageProvider()` now automatically inject platform-appropriate WebSocket factories
- **`IpfsHttpClient.getGateways()`** — New public accessor returning configured gateway URLs
- **`IpfsStorageConfig` extensions** — New optional fields: `createWebSocket`, `wsUrl`, `fallbackPollIntervalMs`, `syncDebounceMs`
- **`IpnsUpdateEvent` type** — Exported from `impl/shared/ipfs` for consumers
- **24 unit tests** for `IpnsSubscriptionClient` covering subscribe, message handling, reconnection, keepalive, fallback polling, and disconnect

### Fixed
- **IPFS token recovery via TXF merge** — `mergeTxfData()` now recognizes individual token entries (`token-*` keys) stored via `saveToken()`, not just `_`-prefixed TXF keys; previously IPFS sync returned `added: 0` because merge couldn't find tokens in the blob
- **TXF parser handles individual file format** — `parseTxfStorageData()` now extracts tokens from `{ token, meta }` wrapper format used by IPFS individual token storage
- **Sync coalescing** — `PaymentsModule.sync()` now coalesces concurrent calls, preventing race conditions when multiple syncs overlap

### Changed
- All `throw new Error()` in production code replaced with `throw new SphereError()` — zero plain errors remaining
- All `console.log/warn/error` in production code replaced with `logger.debug/warn/error` — console output controlled by debug flag
- `logger.warn()` and `logger.error()` are always shown regardless of debug flag; `logger.debug()` is hidden when `debug=false`
- `PaymentsModule.updateTokenStorageProviders()` now re-subscribes to storage events when providers change
- `PaymentsModule.destroy()` now cleans up storage event subscriptions and debounce timers
- `IpfsStorageProvider.shutdown()` now disconnects the subscription client

[Unreleased]: https://github.com/unicitynetwork/sphere-sdk/compare/main...HEAD
