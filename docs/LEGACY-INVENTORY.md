# Legacy inventory — what still exists only for backwards compatibility

The wallet is on testnet and heading to mainnet, where the SDK should carry no
back-compat branches. This is the inventory that decision was made from: every
candidate was hunted with git evidence, then handed to a second agent whose only
job was to REFUTE "safely removable". The bar that overrides "an old build
breaks": funds must never become unreachable without a loud error.

Status counts at the time of the sweep: **94 REMOVE-NOW · 35 REMOVE-WITH-MIGRATION · 15 KEEP**.

Two rules the removals follow:
- delete the whole surface — branch, types, constants, exports, docs, tests — not just the tip;
- where an old shape can still ARRIVE at runtime (a stored record, a wire payload, a
  peer's message), refuse it LOUDLY rather than silently mis-read it as the new shape.

## KEEP — labelled legacy, but load-bearing
These read as legacy and are not. Do not delete them on the strength of a comment.
- **modules/payments/PaymentsModule.ts:4502** — The sphere-envelope (`try`) arm of `handleV2Transfer`'s tolerant blob decode — `try { blob = decodeTokenBlob(bytes) } catch { blob = { v, network: 0, tokenId: '', token: bytes } }`.
  - why it stays: I set out to confirm the arm was dead and instead found it is the port-contract default.

WHAT THE CANDIDATE GOT RIGHT (verified): `WalletApiMailboxProvider.prepareBlob` calls `unwrapTokenBlobBytes(blob)` before upload (WalletApiMailboxProvider.ts:~305) and `fetchBlob()` returns `client.fetchBlob(en
- **modules/payments/PaymentsModule.ts:824,5337-5352** — `interface IntentPayloadV1` (name says V1, only legal `v` is `2`) plus the `if (payload.v !== 2 || !Array.isArray(payload.direct))` refusal in `resumeOpenIntents`.
  - why it stays: I tried five ways to make removal safe and each one turned up a reason not to.

1) SCOPE REFUTATION (strongest, and the candidate missed it). This is not "a v:1 refusal branch". It is one `if` with TWO predicates, and `!Array.isArray(payload.direct)` is not a version check and is not legacy — it is
- **modules/payments/PaymentsModule.ts (accumulateToken now at :3341, else-branch :3351-3353 — the candidate's line numbers are ~26 lines stale, see reasoning)** — The `unconfirmed` bucket of asset aggregation: `AssetAccumulator.unconfirmedAmount`/`unconfirmedTokenCount`, the catch-all `else` in `accumulateToken`, and the `Asset.unconfirmedAmount`/`unconfirmedTo
  - why it stays: I tried five ways to break the removal and three of them landed.

(1) HUNT: a live producer of a non-confirmed status. Mostly confirms the candidate. Grep over modules/ core/ storage/ serialization/ impl/ finds no production assignment of `'pending'`/`'submitted'` to `Token.status` — the `status: 'p
- **core/encryption.ts:16** — The `EncryptedData` apparatus — `encrypt`, `decrypt`, `decryptJson`, `isEncryptedData`, `serializeEncrypted`, `deserializeEncrypted`, `generateRandomKey`, plus the `encryptMnemonic`/`decryptMnemonic` 
  - why it stays: I went looking for the one thing that would make removal unsafe — a live caller outside this repo — and found it immediately, in the sibling checkout the candidate said it "could not inspect".

REFUTATION 1 — `encrypt` + `decryptJson` are live.
/home/pavelg/unicity/sphere/src/sdk/walletLock/lockSett
- **core/Sphere.ts:455 (declaration), core/Sphere.ts:751-856 (the `init()` that drops it), core/Sphere.ts:983/1084/1191 (create/load/import assign it), core/Sphere.ts:4464 (buildTokenEngine consumes it), token-engine/factory.ts:104-105, docs/VERIFICATION-WORKERS.md, CHANGELOG.md:45-56, tests/integration/address-switch-engine-lifecycle.test.ts:144** — `SphereInitOptions.verification` (opt-in parallel token-verification worker-pool config). The candidate's factual claim is correct — `Sphere.init()` never forwards it — but the field is NOT legacy: it
  - why it stays: WHAT I TRIED TO FIND THAT WOULD MAKE REMOVAL SAFE — and failed to find:

1. Evidence it is dead everywhere, not just at `init`. REFUTED. `_verification` is read at core/Sphere.ts:4464 by `buildTokenEngine`, which runs for EVERY engine (boot, each address switch, `setOracleApiKey` rebuild), and flows
- **types/txf.ts:16** — The v1 TXF token structure — TxfToken/TxfGenesis/TxfGenesisData/TxfState/TxfTransaction/TxfInclusionProof/TxfAuthenticator/TxfMerkleTreePath/TxfMerkleStep/TxfIntegrity
  - why it stays: I set out to find a producer, a live consumer, or a money path, and found all three.

REFUTATION 1 (decisive — a v2 producer, today). `AccountingModule._scanTokenForAttribution` (modules/accounting/AccountingModule.ts:4032-4072) CONSTRUCTS a TxfToken from a **v2 engine token** and feeds it to the at
- **core/Sphere.ts:3823** — The `fromLegacy` flag inside `syncIdentityWithTransport()` — the "Old-format events don't have content.nametag (only encrypted_nametag)" fallback that calls `transport.recoverNametag()`, then re-publi
  - why it stays: I tried four independent ways to prove this is safely deletable and failed on the mechanism, but succeeded on the flag.

(1) IS THE SHAPE STILL PRODUCED? Yes, by today's SDK — the "legacy" label is simply wrong. `node_modules/@unicitylabs/nostr-js-sdk/dist/esm/nametag/NametagBinding.js`: `createBind
- **serialization/wallet-text.ts** — The 'UNICITY WALLET DETAILS' text wallet format — LEGACY_SALT='alpha_wallet_salt' + PBKDF2-SHA1/100k, used for both reading and writing encrypted wallet exports.
  - why it stays: I tried four ways to confirm "safely removable" and three of them refuted it.

(1) LIVE CALLER, OUTSIDE THIS REPO. The reader is not dormant. In the actual Sphere frontend (/home/pavelg/unicity/sphere): src/components/wallet/onboarding/hooks/useOnboardingFlow.ts:375-377 calls Sphere.detectLegacyFile
- **token-engine/SphereTokenEngine.ts** — The "response-parse throw (e.g. the transitional STATE_ID_EXISTS)" rationale on `submitAndAwaitProof` (:645-660) and the status-agnostic rationale on `CLEAN_REJECT_STATUSES` (:156-159), plus the `Subm
  - why it stays: I tried to confirm the parse-throw arm is dead and failed on four counts.

(1) THE PARSE-THROW ARM IS STILL REACHABLE. The evidence proves only that an unknown *status string* parses cleanly. But `CertificationResponse.isJSON` (node_modules/@unicitylabs/state-transition-sdk/lib/api/CertificationResp
- **token-engine/token-blob.ts:18** — `TOKEN_BLOB_VERSION = 1` and the `TokenBlob.v` field — the sphere-private CBOR envelope's version discriminator, validated by `decodeTokenBlob` (token-blob.ts:41-43).
  - why it stays: I tried to prove it removable and failed on four independent grounds; I also refuted one claim the candidate makes in its favor.

WHAT SURVIVED (candidate was right):
"Only v=1 has ever existed, no compatibility branch." Confirmed via history, not just grep: `git log -S TOKEN_BLOB_VERSION` shows it
- **token-engine/token-blob.ts:62** — `unwrapTokenBlobBytes` (tolerant dual-form: decode the sphere-private 39051 `TokenBlob` envelope, else pass bytes through) plus its two mirroring tolerant decodes — `WalletApiTokenStorageProvider.wrap
  - why it stays: I tried four ways to kill it and all four failed.

(1) "The pass-through arm is dead — everything is the envelope." REFUTED. `WalletApiMailboxProvider.toIncomingDelivery().fetchBlob()` (WalletApiMailboxProvider.ts:522-541) returns whatever the backend blob store serves, and `WalletApiTokenStoragePro
- **token-engine/engine.ts:59** — `EngineOpOptions.checkpointStore` being optional, plus the store-less burn branch in `SphereTokenEngine.resolveBurntToken` (/home/pavelg/unicity/sphere-sdk/token-engine/SphereTokenEngine.ts:439-441: `
  - why it stays: I set out to prove the candidate's claimed reachability, and it collapsed.

REFUTED CLAIM: "Reachable on every local (non-wallet-api) split today ... the default SDK composition." False. `PaymentsModule.sendOnce()` (/home/pavelg/unicity/sphere-sdk/modules/payments/PaymentsModule.ts:2002-2005) calls
- **modules/swap/dm-protocol.ts:649** — `parseInvoiceDelivery` requires `invoice_token` to be a non-null OBJECT (v1 TXF JSON) while `AccountingModule.importInvoice` requires a STRING (v2 hex blob) and throws on anything else — the escrow de
  - why it stays: WHAT I CONFIRMED (all candidate facts hold). dm-protocol.ts:649 rejects anything non-object; AccountingModule.ts:1101-1106 throws INVOICE_INVALID_DATA on anything non-string. I proved the mutual exclusion by running both shapes through the real `parseSwapDM`: a v2 hex string returns NULL (dropped),
- **modules/accounting/AccountingModule.ts** — `resolveInvoiceRef` (:3581) direct-match branch + the `invoiceIdHashIndex` / `_rebuildHashIndex` (:3556) / `_addToHashIndex` (:3567) machinery.
  - why it stays: I tried to confirm the claim "the hash branch needs an on-chain memo, which nothing writes" and REFUTED it. buildInvoiceMemo (memo.ts:187) returns `INV:${hashInvoiceId(id)}:${dir}` and is the TRANSPORT memo builder, not the on-chain one — #708 removed parseInvoiceMemoForOnChain (the on-chain produce
- **connect/protocol.ts:196** — `SphereHandshake.warning?: SphereRpcError` — an optional, non-fatal deprecation-notice slot on the handshake RESPONSE frame. Producer side: `ConnectHost.sendHandshakeResponse()` 6th positional param (
  - why it stays: I tried four ways to make removal unsafe and found no MONEY hazard — but I found that the "dead-fossil" classification is factually wrong, which is the reason to keep.

WHAT I CONFIRMED IN THE CANDIDATE'S FAVOUR (removal is money-safe):
- No money path whatsoever. `warning` lives only on the handsha

## REMOVE-WITH-MIGRATION — needs a loud refusal or a data path
- **constants.ts:222** — NOSTR_EVENT_KINDS.TOKEN_TRANSFER (31113), PAYMENT_REQUEST (31115), PAYMENT_REQUEST_RESPONSE (31116) — and, unavoidably, the whole orphaned Nostr rail hanging off them (transport se
- **core/Sphere.ts:1315** — `Sphere.clear()`'s dual signature: a bare positional `StorageProvider` (legacy) vs the `{ storage, tokenStorage? }` options object, discriminated at runtime by `'get' in storageOrO
- **core/Sphere.ts:2004** — `Sphere.importFromLegacyFile` / `detectLegacyFileType` / `isLegacyFileEncrypted` plus the serialization/wallet-dat.ts + wallet-text.ts stack behind them.
- **core/Sphere.ts:4442, :4455, :4469, :1621-1622** — Four text fragments (one doc comment, two warn strings, one doc comment) claiming that modules "fall back to their legacy path" / "keep their legacy path" when `buildTokenEngine` r
- **core/Sphere.ts:4721** — `decrypt()` fallback that decrypts a stored mnemonic/master key with the hardcoded `DEFAULT_ENCRYPTION_KEY` ('sphere-default-key') when no password is set and the blob isn't alread
- **core/Sphere.ts:4721** — `Sphere.decrypt()` back-compat branch: with no password and after the plaintext (BIP39 / 64-hex) check fails, decrypt the stored mnemonic / master key with the hardcoded `DEFAULT_E
- **impl/browser/storage/IndexedDBTokenStorageProvider.ts:157 (and impl/nodejs/storage/FileTokenStorageProvider.ts:103-131)** — Legacy key-shape handling in the two local token-storage providers: the `token-`/`nametag-` skip filters, the `archived-` load/save branches, and the nodejs `archived_` readdir fil
- **impl/shared/wallet-api/WalletApiMailboxProvider.ts:397** — `depositChunk`'s 404 arm: a `NOT_FOUND` from `POST /v1/mailbox/batch` is read as "pre-#111 deployment", latches `batchDepositUnsupported = true` on the instance, and permanently de
- **impl/shared/wallet-api/WalletApiTokenStorageProvider.ts:274** — `mayHaveSpent`'s bare-`${tokenId}` knownSpends read (line 275: `if (known.has(tokenId)) return true; // legacy bare entry`), documented at line 234 as a shape only "legacy builds w
- **impl/shared/wallet-api/WalletApiTokenStorageProvider.ts:534** — `wrapWireBlob(tokenId, bytes)` tries `decodeTokenBlob(bytes)` (sphere-private CBOR tag 39051 envelope) before falling back to a raw wrap `{v:1, network:0, tokenId, token: bytes}`. 
- **modules/accounting/AccountingModule.ts:386** — `_doLoad()` step 2–3: the only reload path for `invoiceTermsCache`, implemented as `JSON.parse(token.sdkData) as TxfToken` + filter on `txf.genesis.data.tokenType === INVOICE_TOKEN
- **modules/accounting/AccountingModule.ts:4032** — The on-chain memo attribution subsystem: `_scanTokenForAttribution` → `_processTokenTransactions` → `decodeTransferMessage` → `tokenScanState` watermarks + `_gapFillTokenScan` + `_
- **modules/payments/PaymentsModule.ts** — `IntentPayloadV1.spentStates?` (optional, "Absent on legacy (pre-M7) payloads", L844) plus its two consumer fallbacks: `payload.spentStates?.[id]?.protocol ?? ''` at the `applyInve
- **modules/payments/PaymentsModule.ts:1379-1386** — `isLegacyAlpha` — the `_meta.address?.startsWith('alpha1')` exemption in PaymentsModule.load()'s token-storage address guard, which lets a record whose `_meta.address` is a pre-L1-
- **modules/payments/PaymentsModule.ts:1385** — The `isLegacyAlpha` escape hatch in PaymentsModule.load()'s token-storage address guard: `_meta.address?.startsWith('alpha1')` suppresses the cross-address rejection for pre-L1-rem
- **modules/payments/PaymentsModule.ts:2765** — `acceptPaymentRequest(requestId)` (L2755-2768) and `markPaymentRequestPaid(requestId)` (L2786-2795) — two public PaymentsModule entry points that only mutate in-memory request stat
- **modules/payments/PaymentsModule.ts:382** — `ReceiveOptions` (declaration :382, export `index.ts:265`) and the unread `_options?: ReceiveOptions` first parameter of `PaymentsModule.receive()` (:3148).
- **modules/payments/PaymentsModule.ts:41** — `isV2TransferPayload` (defined in /home/pavelg/unicity/sphere-sdk/types/v2-transfer.ts:27) is imported at PaymentsModule.ts:41 and never called. The `type: 'V2_TRANSFER'` / `versio
- **modules/payments/PaymentsModule.ts:4121** — The local minted-token nametag store in PaymentsModule: the `nametags: NametagData[]` field (L958), its five public methods `setNametag`/`getNametag`/`getNametags`/`hasNametag`/`cl
- **modules/payments/PaymentsModule.ts:4307** — `payments.sync()` — the post-d1b1c397 shell around `save()`: the `sync` name, the constant `{added: 0, removed: 0}` return, the `sync:started`/`sync:completed`/`sync:error` events,
- **modules/payments/PaymentsModule.ts:509-541** — The non-blob fallback branch of `parseSdkDataCached` — `JSON.parse(sdkData)` → `genesis.data.tokenId` + `getCurrentStateHash(txf)`, plus the three further guesses `state.hash` / `s
- **modules/payments/PaymentsModule.ts:513** — The non-blob arm of `parseSdkDataCached` — JSON.parse of `sdkData` as v1 TXF to recover `(tokenId, stateHash)`, plus the three "alternative location" probes (`state.hash`, `stateHa
- **modules/payments/PaymentsModule.ts:634** — `PaymentsModuleConfig` (all five options: `autoSync`, `autoValidate`, `retryFailed`, `maxRetries`, `debug`), the private `moduleConfig` field (:947), the constructor defaulting blo
- **modules/payments/PaymentsModule.ts:854** — `PaymentsModuleDependencies.tokenStorage` — the `@deprecated` single-provider alias for `tokenStorageProviders`, plus its two fallback branches: `firstEnabledTokenStorage` (L897-89
- **modules/swap/dm-protocol.ts:451,512)** — Every protocol-v1 inbound branch in the swap module: the `!swap.protocolVersion || swap.protocolVersion < 2` announce arm (SwapModule.ts:2648), the v1 crash-recovery `else` (:404),
- **oracle/UnicityAggregatorProvider.ts:159** — The oracle provider's event subsystem: `eventCallbacks` (:57), `onEvent()` (:159-162), `emitEvent()` (:168-176), its two emit call sites in `connect()`/`disconnect()` (:115, :121),
- **serialization/txf-serializer.ts:563** — Six v1-TXF utility exports: getTokenId, getCurrentStateHash, hasValidTxfData, hasUncommittedTransactions, hasMissingNewStateHash, countCommittedTransactions.
- **serialization/wallet-dat.ts:1** — Bitcoin Core wallet.dat importer — SQLite byte-scan, CMasterKey/mkey extraction, PBKDF2-SHA512 (iterated SHA512) key derivation, descriptor + legacy-key extraction, BIP32 xpub chai
- **token-engine/types.ts:114** — `TransferParams.data` (types.ts:113-114) and `SplitOutput.data` (types.ts:127-128) — the on-chain memo INPUT to a transfer/split output — plus their two engine plumbing sites (`par
- **token-engine/types.ts:59** — `TokenBlob.network` — the second element of the sphere-private CBOR tag-39051 envelope (`tag(39051)[v, network, tokenId, token]`), written by `encodeTokenBlob` and read back by `de
- **transport/MultiAddressTransportMux.ts:1060** — kind-14 control-message compatibility filter (`read_receipt` / `typing` / bare-composing JSON smuggled in a normal DM gift wrap) + the self-wrap suppressor at line 991
- **transport/websocket.ts:64)** — The `Math.random()` UUID fallbacks in `createRequestId()` (connect/protocol.ts:328-334) and `defaultUUIDGenerator()` (transport/websocket.ts:60-70), both guarded by a `crypto.rando
- **types/txf.ts:123 (+ modules/payments/PaymentsModule.ts:958,4121-4183,6151,6196; serialization/txf-serializer.ts:282-301,365-423)** — NametagData, the `_nametag`/`_nametags` storage slots, and the PaymentsModule nametag-token store (private `nametags[]`, setNametag/getNametag/getNametags/hasNametag/clearNametag) 
- **types/txf.ts:252** — ARCHIVED_PREFIX / FORKED_PREFIX constants plus the six exported key helpers isArchivedKey, isForkedKey, tokenIdFromArchivedKey, archivedKeyFromTokenId, forkedKeyFromTokenIdAndState
- **wallet-api/client.ts:1243** — `WalletApiClient.connectWakeSocket(onWake)` — the bare, non-self-healing wake socket (nulls `onerror`/`onclose` after open) plus its return type `WakeSocketHandle` (wallet-api/type

## REMOVE-NOW

### constants.ts
- Storage keys `PROCESSED_SPLIT_GROUP_IDS` ('processed_split_group_ids') and `PROCESSED_COMBINED_TRANSFER_IDS` ('processed_combined_transfer_ids') — declared in `STORAGE_KEYS_ADDRESS` (constants.ts:99-1
- Two coupled legacy relics: (1) `export const STORAGE_KEYS = { ...STORAGE_KEYS_GLOBAL, ...STORAGE_KEYS_ADDRESS }` — a merged compatibility map deprecated since 5016528d (2026-02-03), re-exported public
- `/** @deprecated Use STORAGE_KEYS_GLOBAL and STORAGE_KEYS_ADDRESS instead */ export const STORAGE_KEYS = {...STORAGE_KEYS_GLOBAL, ...STORAGE_KEYS_ADDRESS} as const` — a flattened back-compat alias, pl
- STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS ('pending_v5_tokens'), its NETWORK_SCOPED_ADDRESS_KEYS entry (constants.ts:135), the delete-on-load block at modules/payments/PaymentsModule.ts:1445-1454, and th
- STORAGE_KEYS_ADDRESS.PROCESSED_SPLIT_GROUP_IDS (V5) and PROCESSED_COMBINED_TRANSFER_IDS (V6) — Nostr re-delivery dedup ledgers — plus their two NETWORK_SCOPED_ADDRESS_KEYS entries (constants.ts:99-102
- STORAGE_KEYS_ADDRESS members PENDING_TRANSFERS (:73), OUTBOX (:75), CONVERSATIONS (:77), TRANSACTION_HISTORY (:81), their entries in NETWORK_SCOPED_ADDRESS_KEYS (:132-134), and the only remaining TRAN
- DEFAULT_AGGREGATOR_URL (283), DEV_AGGREGATOR_URL (286), TEST_AGGREGATOR_URL (289) — three v1-era aggregator endpoint constants, re-exported from index.ts:330-332, two of which populate NETWORKS.mainne

### core/Sphere.ts
- `loadTrackedAddresses()`'s fallback branch (reads `STORAGE_KEYS_GLOBAL.ADDRESS_NAMETAGS` when the `TRACKED_ADDRESSES` registry is empty) plus the `migrateFromOldNametagFormat()` helper it calls — a 0.
- `Identity.ipnsName` — the `'12D3KooW' + sha256(pubkey).slice(0,40)` pseudo-peer-id computed at four identity-construction sites in core/Sphere.ts (2471/2503, 4209/4216, 4249/4258, 4301/4310), exposed 
- `Sphere.cleanupOrphanedVestingCache(once)` — a best-effort `indexedDB.deleteDatabase('SphereVestingCacheV5')` plus its `_orphanCacheCleaned` static latch, called from `initializeProviders()` (once-per
- `private _addressIdToIndex: Map<string, number>` — a write-only reverse index (addressId → HD index) populated in `loadTrackedAddresses` (3652), `migrateFromOldNametagFormat` (3719), `ensureAddressTra
- `getAllAddressNametags(): Map<string, Map<number, string>>` — deprecated public getter enumerating the internal `_addressNametags` cache (addressId → nametagIndex → name), superseded by the tracked-ad
- `getTokenStorage()` — deprecated public accessor returning the first entry of `_tokenStorageProviders`; superseded by `getTokenStorageProviders()`.
- Stale trailing clause in the `postSwitchSync()` comment: "the on-chain UnicityIdToken claim is additionally minted + stored below, best-effort." There is no mint below — the method ends after the `nam
- The "Auto-sync with token storage providers (e.g., IPFS) to recover tokens" block at the tail of `Sphere.import()` — a `sphere._payments.sync()` gated on `_tokenStorageProviders.size > 0`, emitting th
- `DerivationMode` union member `'legacy_hmac'` and its two doc-comment echoes. It is a name for a key-derivation scheme this SDK has never been able to perform: `core/crypto.ts` contains exactly two de

### core/address.ts
- `PROXY://` as a first-class address type: `PROXY_PREFIX`, the `'PROXY'` arm of the exported `AddressType` union, its `parseAddress` branch, its `normalizeAddress` case, and the mirrored `DIRECT://`-or

### core/bech32.ts
- Entire BIP-173 bech32 module: `convertBits`, `encodeBech32`, `decodeBech32`, `createAddress`, `isValidBech32`, `getAddressHrp`, `CHARSET`. Orphaned by cbac6f38 "Remove L1 — L3-only (#604)" (2026-06-18

### core/discover.ts
- Single-inhabitant discriminator unions left from two-phase (transport + L1) discovery: `DiscoverAddressProgress.phase: 'transport'` (core/discover.ts:23-24, written :126) and `DiscoveredAddress.source

### core/network-health.ts
- `checkOracle()` probes the gateway with the deleted v1 aggregator JSON-RPC method `get_round_number` and reports health purely from `response.ok`. Both halves are wrong: the method no longer exists on

### core/utils.ts
- `base58Encode(hex: string): string` — public export with zero call sites; a raw (checksum-less) Bitcoin-style hex→base58 formatter left over from the L1 era.
- The `else { require('crypto').randomBytes(...) }` fallback branch inside `randomHex()` — the guard `if (typeof globalThis.crypto !== 'undefined')` plus its CJS-require else-arm. The `randomHex` functi

### impl/browser/oracle/index.ts
- `createUnicityOracleProvider` / `UnicityOracleProvider` / `UnicityOracleProviderConfig` — pure Oracle→Aggregator rename shims. 4 declaration sites (2 create-fn aliases in the browser/node oracle entry

### impl/browser/storage/IndexedDBTokenStorageProvider.ts
- `_outbox` / `_sent` / `_invalid` persist+restore in both local token-storage providers — v1-era pending-transfer bookkeeping with zero producers and zero consumers left after the V5/v1 cutover.
- `// Re-export HistoryRecord for backwards compat` + `export type { HistoryRecord } from '../../../storage';` — a type-only alias of the canonical `HistoryRecord` declared at /home/pavelg/unicity/spher
- `archived-` key handling in the two local token-storage providers (IndexedDB load :163-166 / save :229,:258-260; File load :124-127 / save :184-187, plus the `archived_` underscore filter at FileToken
- The `token-` / `nametag-` row-id skip in both local TokenStorageProvider `load()` implementations, justified by a comment pointing at `loadTokensFromFileStorage` — a function that no longer exists. Pl

### impl/shared/config.ts
- Oracle `timeout` config knob — threaded `BaseOracleConfig` → `resolveOracleConfig` → `createBrowserProviders`/`createNodeProviders` → `UnicityAggregatorProvider.config.timeout` (defaulted from `DEFAUL
- `skipVerification` — v1-era "skip trust base verification (dev only)" flag plumbed BaseOracleConfig → ResolvedOracleConfig → both platform provider factories → UnicityAggregatorProvider, where its ONL

### impl/shared/resolvers.ts
- The `= 'mainnet'` default parameter on `getNetworkConfig(network: NetworkType = 'mainnet')` — a silent fallback to a network the SDK refuses to run. The *function* is load-bearing (5 call sites); only

### impl/shared/trustbase-loader.ts
- `getEmbeddedTrustBase`'s `case 'dev'` returns `TRUSTBASE_DEV`, a straight alias of `TRUSTBASE_TESTNET` — the v1 networkId-3 trust base (assets/trustbase.ts:6-26, aliased at :76 with the comment "same 

### impl/shared/wallet-api/WalletApiTokenStorageProvider.ts
- The `|| 'genesis' in entry` clause in `isV2BlobEntry` — a v1-TXF discriminator that keeps pre-cutover stored relics out of the wallet-api write-behind upload path (`pushAdditions`, its only call site,
- `_meta: { version: 1, formatVersion: '2.0' }` stamped by all three token-storage providers' `load()` (WalletApiTokenStorageProvider.ts:704, IndexedDBTokenStorageProvider.ts:144, FileTokenStorageProvid

### index.ts
- StorageEventType / StorageEvent / StorageEventCallback — the storage push-event triple, orphaned when TokenStorageProvider.onEvent was dropped in d1b1c397 (#711), itself unreachable since IPFS was rem

### modules/accounting/AccountingModule.ts
- `importInvoice(token: TxfToken | string)` — the public param still admits the v1 TXF object type only so lines 1101-1106 can throw a bespoke "Legacy (v1 TXF)" rejection for it.
- `_handleTokenChange(tokenId, sdkData)` — the `payments.onTokenChange` observer registered at :4341. Parses `sdkData` as v1 TXF JSON, walks `txf.transactions`, calls `_processTokenTransactions`, then s

### modules/accounting/memo.ts
- `parseInvoiceMemoForOnChain` (memo.ts:389-450) — the on-chain invoice memo builder, plus its helper `encodeTransferMessage` (memo.ts:353) and the now-orphaned `DIRECTION_TO_CODE` (memo.ts:65). Both bu

### modules/accounting/types.ts
- `InvoiceMessageRef.ra` / `.ct` (the on-chain `TransferMessagePayload` refund-address and contact fields) and the `refundAddress` / `contact` members they populate on `InvoiceTransferRef`, `InvoiceSend

### modules/communications/CommunicationsModule.ts
- load()'s fallback read of the pre-per-address global 'direct_messages' storage key, filtering by identity and re-saving under STORAGE_KEYS_ADDRESS.MESSAGES.

### modules/payments/PaymentsModule.ts
- `ipnsName: this.deps!.identity.ipnsName ?? ''` written into the TXF `_meta` block on every save, via `buildTxfStorageData` in `createStorageData()`.
- The unconditional `await this.deps!.storage.remove(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS)` (plus its try/catch + warn) in `PaymentsModule.load()`'s `doLoad()` — the residue of the v1-cutover orphaned
- `loadHistory()`'s "One-time migration from legacy KV storage" block (L3887-3907: read `STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY`, `importHistoryEntries`, `storage.remove`) plus the terminal `else` arm
- The stale-`_placeholder` sweep in `load()` — JSON.parse every loaded token's `sdkData`, delete any whose parsed object has a truthy `_placeholder`.
- `mergeTombstones(remoteTombstones: TombstoneEntry[]): Promise<number>` — public PaymentsModule method that unions remote tombstones into the local set and deletes any local token whose `(tokenId, stat
- The `_history` round-trip through the TXF storage blob: `MAX_SYNCED_HISTORY_ENTRIES` (PaymentsModule.ts:131), the `historyEntries: sorted.slice(0, 5000)` write in `createStorageData` (:6142-6153), the
- `resolveSenderInfo(senderTransportPubkey)` (PaymentsModule.ts:3764-3786) and its single call in `handleV2Transfer` (:4572), plus the `...senderInfo` spread into `addToHistory` (:4591) — a Nostr transp
- `resolveTransportPubkey(recipient, peerInfo)` (L4450-4470) and its single call site in `resolveSendTarget` (L1720) — deriving a Nostr x-only transport pubkey for a send. Its only surviving output is t
- `PendingV2Delivery.opIndex?` (optional, L348, "Absent on legacy entries") and the positional fallback `byOp.set(e.opIndex ?? i, e)` in `journaledByOp` (L5866).
- Stale "path B / legacy v1 SDK path" prose on the optional `tokenEngine` dependency and the matching Sphere warn strings. There is no legacy path — every engine-absent branch is a loud refusal or a saf
- `oracle: OracleProvider` — a required field on `PaymentsModuleDependencies` that the module never reads. Ceremony left behind when the v1 cutover moved all oracle consumption to `Sphere.buildTokenEngi
- The `&& this.paymentRequestsApi()` conjunct on the #441 settling branch, plus the two comments that justify it as the "Nostr-only composition" fallback (L2892-2896 rationale and the first clause of th
- The one-time legacy-KV history migration in loadHistory() (reads STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY, backfills dedupKeys, imports into the provider history store, deletes the key) plus the else-
- The "Remove stale placeholder tokens from interrupted sends" sweep in `PaymentsModule.loadWith()`/`doLoad()` — a per-load loop that JSON.parses every token's `sdkData` looking for `{"_placeholder":tru
- The `_history` blob round-trip: createStorageData() serializes the newest 5000 history rows into the TXF storage blob on every save, and load() reads them back and re-imports them into the same provid

### modules/payments/SpendQueue.ts
- `export const MAX_SKIP_COUNT = 10` — a fossil of a deleted head-of-line-blocking starvation guard, self-labelled "Exported for test compatibility. Not used by production queue logic."

### modules/payments/TokenReservationLedger.ts
- `export const RESERVATION_TIMEOUT_MS = 30_000` and `TokenReservationLedger.cleanup(maxAgeMs)` — the age-expiry sweep it was the parameter for. Both are orphans of a sweeper that was specified in a des

### modules/payments/TokenSplitCalculator.ts
- The file header's "a v1 SDK token today, a v2 `SphereToken` once the engine path is wired" and the resulting `TokenWithAmount.sdkToken: unknown` (plus its twin `ParsedTokenEntry.sdkToken: unknown` in 

### modules/swap/dm-protocol.ts
- `buildProposalDM` — the protocol-v1 swap-proposal DM emitter. Exported from `modules/swap/dm-protocol.ts`, re-exported by the internal barrel `modules/swap/index.ts:5`, imported (unused) at `modules/s

### modules/swap/manifest.ts
- `PROXY://` routing in NostrTransportProvider.resolve() — the `|| identifier.startsWith('PROXY:')` clause that forwards a PROXY string to resolveAddressInfo(), plus the "DIRECT:// or PROXY://" doc clai

### modules/swap/types.ts
- `SwapStorageData.version: 1` — the outer wrapper version tag on the per-swap storage record (`swap:{swapId}` key), written by SwapModule.persistSwap and never used to make a decision.

### oracle/UnicityAggregatorProvider.ts
- `UnicityOracleProvider` / `UnicityOracleProviderConfig` deprecated aliases in oracle/UnicityAggregatorProvider.ts, plus the `createUnicityOracleProvider = createUnicityAggregatorProvider` re-exports a
- `UnicityAggregatorProviderConfig.timeout` and `.debug` — accepted, defaulted (`DEFAULT_AGGREGATOR_TIMEOUT`), stored on the private `this.config`, never read again. Only `url`, `apiKey`, `skipVerificat

### oracle/oracle-provider.ts
- The four `Aggregator*` back-compat type aliases (`AggregatorProvider`, `AggregatorEventType`, `AggregatorEvent`, `AggregatorEventCallback`) in the "Backward Compatibility Aliases" block at oracle/orac

### registry/TokenRegistry.ts
- `cacheKeys()`'s un-namespaced fallback branch — `if (!this.remoteUrl) return { data: 'token_registry_cache', ts: 'token_registry_cache_ts' }` — the pre-namespacing bare cache key retained "for local-o
- `export type RegistryNetwork = 'testnet' | 'mainnet' | 'dev';` — a type-only alias with zero uses, re-exported at /home/pavelg/unicity/sphere-sdk/registry/index.ts:13 and /home/pavelg/unicity/sphere-s

### serialization/txf-serializer.ts
- The `archivedTokens`/`forkedTokens` options on `buildTxfStorageData` (lines 284-285, 338-353), the two Map fields on `ParsedStorageData` (367-368, 385-386), and the `isArchivedKey`/`isForkedKey` parse
- The singular `_nametag` back-compat reader in `parseTxfStorageData()` (lines 417-423), plus the `seenNames` set (line 407) that exists only to serve it.
- The v1 TXF read/write half of the serializer: bytesToHex, normalizeToHex, normalizeSdkTokenToStorage, tokenToTxf, objectToTxf, determineTokenStatus, txfToToken.
- The `else if (key.startsWith('token-'))` branch in `parseTxfStorageData` that unwraps `{ token: TxfToken }` records into v1 TXF tokens — the reader for the removed "lottery-compatible" per-file token 

### serialization/wallet-dat.ts
- `WalletDatInfo` — an 11-field TypeScript interface describing a parsed Bitcoin Core wallet.dat (isSQLite, isEncrypted, isDescriptorWallet, hasHDChain, descriptorKeys, legacyKeys, chainCode, descriptor

### storage/storage-provider.ts
- An orphaned, unterminated JSDoc opener — `/**` + ` * Subscribe to storage events` with no `*/` — left behind when d1b1c397 (#711) deleted the `onEvent?(callback: StorageEventCallback)` member from the
- SyncResult<T> and the required TokenStorageProvider.sync(localData) port member — a redundant alias of save() whose counters are structurally zero.
- TxfMeta fields written-but-never-read: `formatVersion` ('2.0'), `version` (1), `updatedAt`, `ipnsName` — plus two the candidate missed on the twin declaration: `lastCid` and `deviceId`. Only `_meta.ad
- TxfOutboxEntry / TxfSentEntry / TxfInvalidEntry and the `_outbox` / `_sent` / `_invalid` slots on TxfStorageDataBase, plus the IndexedDB passthrough that reads/writes them (IndexedDBTokenStorageProvid
- SaveResult.cid — the optional IPFS content-id field on the token-storage save result, plus its one surviving echo: the hardcoded `cid: ''` in the `sync:remote-update` event payload (modules/payments/P

### token-engine/SphereTokenEngine.ts
- `EngineOpOptions.transferId` declared optional (`readonly transferId?: string`) plus the `?? randomUUID()` fallback in `SphereTokenEngine.resolveTransferId`, which silently converts a transfer/split i

### token-engine/engine.ts
- `EngineConfig.proofTimeoutMs` — a public, type-only config knob on the frozen ITokenEngine contract that no code path reads. Declared at c18e6879 (2026-06-04) and never wired in any commit on any bran
- `ITokenEngine.deriveIdentityAddress(pubkey?)` (port declaration) + `SphereTokenEngine.deriveIdentityAddress` (/home/pavelg/unicity/sphere-sdk/token-engine/SphereTokenEngine.ts:198-200) — a port method
- `ITokenEngine.readMemo` (token-engine/engine.ts:122) + its implementation `SphereTokenEngine.readMemo` (token-engine/SphereTokenEngine.ts:220-232) — the reader for the on-chain memo channel. Sole prod

### token-engine/identity.ts
- The `export` modifier on `UNICITY_TOKEN_TYPE_HEX` (line 29) and the stale second half of its doc block (lines 25-27) that points at the deleted `token-engine/unicity-id.ts`. The `const`, its value, an

### token-engine/network.ts
- `toNetworkId()` (whole file `token-engine/network.ts`), the `SphereNetwork` union it consumes (`token-engine/types.ts:26-27`), the `SphereNetwork` re-export from the public `./token-engine` barrel (`t

### token-engine/sdk.ts (lines 31, 32, 44, 47, 48, 52, 58, 77, 83, 87)
- Ten unused re-exports of state-transition-sdk symbols from the token-engine anti-corruption barrel: CertifiedMintTransaction, CertifiedTransferTransaction, IVerificationContext, IPredicate, IUnlockScr

### token-engine/types.ts
- Stale doc fossils in token-engine/: process markers naming a finished migration (Track A/B, Phase 0, A4/A6/B6), @see-style pointers at two files that no longer exist anywhere in the repo, one obsolete

### transport/MultiAddressTransportMux.ts
- `handleDirectMessage` — the NIP-04 kind-4 handler that only logs and drops, its mux twin (`case EVENT_KINDS.DIRECT_MESSAGE: break;`), the four subscription filters that still ask the relay for kind 4 

### transport/NostrTransportProvider.ts
- `NostrTransportProvider.sendTypingIndicator` (lines 766-780) emits a kind-14 NIP-17 gift wrap carrying `{type:'typing', senderNametag}`, plus its matching kind-14 receive branch at lines 1327-1344. Bo

### transport/transport-provider.ts
- `/** @deprecated Use PeerInfo instead */ export type NametagInfo = PeerInfo;` — a type-only rename shim in the transport provider contract.

### types/index.ts
- `TransferRequest.addressMode` (`AddressMode = 'auto' | 'direct'`) and `TransferRequest.transferMode` (`TransferMode = 'instant' | 'conservative'`) — optional fields on the public send API, plus their 
- Three optional fields on the public `TokenTransferDetail` shape reached via `TransferResult.tokenTransfers[]`. Introduced by 2dc7b9e9 (Feb 2026) when v1 code genuinely populated them — `requestIdHex` 

### types/txf.ts
- isValidTokenId(tokenId: string): boolean — a one-line 64-hex regex predicate (`/^[0-9a-fA-F]{64}$/`), unchanged on main since the `init` commit.
- TokenValidationResult.action ('ACCEPT' | 'RETRY_LATER' | 'DISCARD_FORK') and ValidationIssue.recoverable in types/txf.ts, plus the ValidationAction / ExtendedValidationResult pair in validation/token-
- `OutboxEntry`, `MintOutboxEntry`, `InvalidatedNametagEntry` (types/txf.ts:143-184) plus their `_outbox` / `_mintOutbox` / `_invalidatedNametags` legs in `serialization/txf-serializer.ts` (build option

### validation/token-validator.ts
- `ValidationAction` / `ExtendedValidationResult` (v1 fork-resolution vocabulary, produced and consumed by nothing) plus the whole `TokenValidator` / `createTokenValidator` module — a read-only wrapper 

### wallet-api/challenge.ts
- `ChallengeExpectation.nowMs` — publicly exported, explicitly `@deprecated` optional field that `verifyChallengeTemplate` never reads; `WalletApiClient.challengeSignIn` (client.ts:411) still passes `no

### wallet-api/codec.ts
- `parseInventoryItem`'s optional-`stateHash` tolerance ("so a pre-exposure server (no field) parses fine"), plus the matching prose degrade in `WalletApiTokenStorageProvider.pushRemovals` (impl/shared/
