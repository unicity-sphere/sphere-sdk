# State Transition v2 Migration — Detailed Specifications (companion)

> Companion to **STATE-TRANSITION-V2-MIGRATION.md** (read that first for goals, decisions, identity, the 2-owner split, phasing, risks). This doc is the deep, code-grounded reference: full engine contract, v2 flow sequences, per-file caller migration, serialization/storage, and the test plan.
>
> ⚠️ **Accuracy note (read once).** v2 deleted most v1 vocabulary. These v1 symbols **do NOT exist in v2** — every site that used them **changes** (there are no "no-op" migrations): `TransferCommitment`, `MintCommitment`, `MintTransactionData`, `TokenSplitBuilder`, `CoinId`, `TokenCoinData`, `coins.get()`, `TokenState`, `UnmaskedPredicate(Reference)`, `MaskedPredicate`, `DirectAddress`, `ProxyAddress`, `AddressScheme`, `RequestId`, `Token.toJSON()/fromJSON()`, `StateTransitionClient.submitTransferCommitment/submitMintCommitment/finalizeTransaction`. Import paths are `@unicitylabs/state-transition-sdk/lib/src/<...>.js` (note `/src/`). Exact transfer/split signatures are re-verified in Phase 0 (Spike S0) before the contract is frozen.

## Contents
- [Part A — Token Engine: contract & internals](#part-a--token-engine-contract--internals)
- [Part B — v2 flows (sender-driven sequences)](#part-b--v2-flows-sender-driven-sequences)
- [Part C — Caller migration (per-file)](#part-c--caller-migration-per-file)
- [Part D — Serialization & storage](#part-d--serialization--storage)
- [Part E — Test plan & merge gate](#part-e--test-plan--merge-gate)

---

## Part A — Token Engine: contract & internals

### A.1 Supporting DTOs (sphere-domain; no v2 type leaks out of `token-engine/`)
```ts
/** Engine identity = the wallet's secp256k1 pubkey. The private key is held inside the wrapper, never in a DTO. */
interface EngineIdentity { chainPubkey: Uint8Array; }            // 33-byte compressed

/** Recipient = a predicate (v2 has NO "address"). = EncodedPredicate(SignaturePredicate(pubkey)); pure fn of chainPubkey; never published. */
type ReceivePredicate = EncodedPredicate;

/** Coin id = hex of v2 AssetId. registry.normalizeCoinId resolves symbols ↔ hex. */
type CoinId = string;

/** Sphere fungible value, implements v2 IPaymentData; encoded into MintTransaction.data. */
interface SpherePaymentData extends IPaymentData {
  assets: PaymentAssetCollection;                                // Asset(AssetId, bigint)[]
  encode(): Promise<Uint8Array>;                                 // versioned, deterministic CBOR
}

/** Storage/UI token = v2 Token + cached blob + decoded value. */
interface SphereToken {
  sdkToken: Token;                                               // v2 SDK Token (CBOR)
  blob: TokenBlob;                                               // see Part D
  owner: ReceivePredicate;                                       // latestTransaction.recipient
  paymentData: SpherePaymentData | null;
}

interface MintParams {
  networkId: NetworkId;                                          // MAINNET=1/TESTNET=2/LOCAL=3
  recipient: IPredicate;                                         // SignaturePredicate(recipientChainPubkey)
  data?: Uint8Array | null;                                     // = await SpherePaymentData.encode()
  tokenType?: TokenType;                                        // default TokenType.generate()
  salt?: TokenSalt;                                             // default TokenSalt.generate(); derives tokenId
  justification?: Uint8Array | null;                           // e.g. SplitMintJustification.toCBOR()
}

interface TransferParams {
  token: SphereToken;
  recipient: IPredicate;                                         // from recipient chainPubkey
  stateMask?: Uint8Array;                                       // default random 32B (privacy/uniqueness)
  data?: Uint8Array | null;
}

interface SplitParams {
  token: SphereToken;
  outputs: Array<{ recipient: IPredicate; coinId: CoinId; amount: bigint }>;
  decodePaymentData: (bytes: Uint8Array) => Promise<IPaymentData>;   // = SpherePaymentData.fromCBOR
}

interface PreparedTransfer { transaction: ITransaction; stateId: StateId; certificationData: CertificationData; }
interface SubmittedTransfer { stateId: StateId; status: CertificationStatus; submittedAt: number; }
interface SplitResult { burn: { predicate: BurnPredicate; transaction: TransferTransaction }; outputs: SphereToken[]; }
interface EngineVerifyResult { ok: boolean; status: VerificationStatus; error?: string; details?: VerificationResult<unknown>; }
type TokenBlob = { /* Part D */ };
type EngineError = SphereErrorCode;
```

### A.2 `ITokenEngine` — two layers
**Façade** (what callers use — most code only needs these):
```ts
interface ITokenEngine {
  // identity / recipients
  getIdentity(): EngineIdentity;                                       // sync
  deriveIdentityAddress(identity?: EngineIdentity): string;            // sync — legacy DIRECT:// (Path A); the ONLY "address"
  deriveReceivePredicate(pubkey: Uint8Array): ReceivePredicate;        // sync — pure fn of chainPubkey
  // value
  readPaymentData(token: SphereToken): SpherePaymentData | null;       // sync (uses cached or decodes)
  balanceOf(token: SphereToken, coinId: CoinId): bigint;               // sync
  // lifecycle (sender-driven)
  mint(params: MintParams): Promise<SphereToken>;                      // build→submit→wait→certify→Token.mint
  transfer(params: TransferParams): Promise<SphereToken>;             // build→sign→submit→wait→certify→token.transfer
  split(params: SplitParams): Promise<SplitResult>;                   // TokenSplit.split + per-output mint
  verify(token: SphereToken): Promise<EngineVerifyResult>;
  isSpent(token: SphereToken): Promise<boolean>;
  // serialization
  encodeToken(token: SphereToken): TokenBlob;                          // sync — Token.toCBOR + header
  decodeToken(blob: TokenBlob): Promise<SphereToken>;                  // Token.fromCBOR + decodePaymentData
}
```
**Granular steps** (internal + split/background/recovery; same interface, additional methods):
```ts
  buildMint(p: MintParams): Promise<MintTransaction>;                  // MintTransaction.create(networkId, recipient, data, tokenType, salt, justification)
  buildTransfer(p: TransferParams): Promise<TransferTransaction>;      // TransferTransaction.create(token.sdkToken, recipient, stateMask, data)
  toCertificationData(tx: ITransaction, unlock?: IUnlockScript): Promise<CertificationData>;
                                                                       // mint → CertificationData.fromMintTransaction; transfer → fromTransaction(tx, unlock)
  submit(cert: CertificationData): Promise<SubmittedTransfer>;        // client.submitCertificationRequest
  awaitProof(tx: ITransaction, signal?: AbortSignal, interval?: number): Promise<InclusionProof>;
                                                                       // waitInclusionProof(client, trustBase, predicateVerifier, tx, signal, interval)
  certifyMint(tx: MintTransaction, proof: InclusionProof): Promise<CertifiedMintTransaction>;     // tx.toCertifiedTransaction(...)
  certifyTransfer(tx: TransferTransaction, proof: InclusionProof): Promise<CertifiedTransferTransaction>;
  mintToToken(g: CertifiedMintTransaction): Promise<SphereToken>;     // Token.mint(trustBase, predicateVerifier, mintJustificationVerifier, g)
  appendTransfer(t: SphereToken, c: CertifiedTransferTransaction): Promise<SphereToken>;          // token.transfer(...)
  verifyInclusionProof(proof: InclusionProof, tx: ITransaction): Promise<EngineVerifyResult>;
```
Notes: `mint`/`transfer`/`split` are the façade compositions of the granular steps. `SplitTokenRequest`/`SplitToken` internal shapes are finalized in Phase 0 against `TokenSplit.split`.

### A.3 `SpherePaymentData` (implements v2 `IPaymentData`) — the value model
v2 `Token` has **no coins**; value is app-defined in `MintTransaction.data`:
```ts
class SpherePaymentData implements IPaymentData {
  static readonly CBOR_TAG = 39050n;          // sphere-specific (distinct from SDK tags) — finalize the number in Phase 0
  private static readonly VERSION = 1n;
  private constructor(public readonly assets: PaymentAssetCollection) {}

  static create(assets: PaymentAssetCollection): SpherePaymentData { return new SpherePaymentData(assets); }

  static fromCBOR(bytes: Uint8Array): SpherePaymentData {        // = the decodePaymentData callback
    const tag = CborDeserializer.decodeTag(bytes);
    if (tag.tag !== SpherePaymentData.CBOR_TAG) throw new CborError(`bad tag ${tag.tag}`);
    const a = CborDeserializer.decodeArray(tag.data, 2);
    if (CborDeserializer.decodeUnsignedInteger(a[0]) !== SpherePaymentData.VERSION) throw new CborError('bad version');
    return new SpherePaymentData(PaymentAssetCollection.fromCBOR(a[1]));
  }

  encode(): Promise<Uint8Array> {                               // tag(39050)[ version, assets.toCBOR() ]
    return Promise.resolve(CborSerializer.encodeTag(SpherePaymentData.CBOR_TAG,
      CborSerializer.encodeArray(CborSerializer.encodeUnsignedInteger(SpherePaymentData.VERSION), this.assets.toCBOR())));
  }
  get version(): bigint { return SpherePaymentData.VERSION; }
}
```
- **CoinId ↔ AssetId:** `new AssetId(hexToBytes(coinId))`; one hex convention shared with `TokenRegistry` (a mismatch silently breaks balances/pricing).
- **Single source of truth:** every balance/spend/split read goes through this codec — never re-implemented ad hoc.
- **Mandatory wiring:** the engine's `MintJustificationVerifierService` MUST register `SplitMintJustificationVerifier(trustBase, predicateVerifier, SpherePaymentData.fromCBOR)`, or split-minted tokens fail `verify`.
- **Adversarial bounds:** cap asset count (mirror old `maxCoinDataEntries`); validate CBOR before allocating; reject malformed.

### A.4 Error mapping (v2 → `SphereError`)
| v2 status / exception | SphereError |
|---|---|
| `CertificationStatus.STATE_ID_EXISTS` | **not an error** — re-fetch proof (idempotent re-submit) |
| `INCLUSION_CERTIFICATE_MISSING` (during poll) | **not an error** — keep waiting |
| `CertificationStatus.SIGNATURE_VERIFICATION_FAILED` / `INVALID_SIGNATURE_FORMAT` / `INVALID_PUBLIC_KEY_FORMAT` / `NOT_AUTHENTICATED` | `SIGNING_ERROR` |
| `INVALID_SHARD` / `MISSING_CERTIFICATION_DATA` | `AGGREGATOR_ERROR` |
| `INVALID_TRUSTBASE` / `PATH_INVALID` / `TRANSACTION_HASH_MISMATCH` / `SHARD_ID_MISMATCH` / `VerificationError` / `CborError` / `TokenAsset*Error` | `VALIDATION_ERROR` |
| `JsonRpcNetworkError(404)` | retry; non-404 → `NETWORK_ERROR` |
| AbortSignal timeout | `TIMEOUT` |
One mapper in `token-engine/errors/`. Strict `status === OK` checks; fail closed; `VerificationResult` is recursive — surface the root cause.

### A.5 Wiring — `SphereTokenEngine` (only place that builds v2 clients is the oracle)
```ts
class SphereTokenEngine implements ITokenEngine {
  constructor(private readonly deps: {
    aggregatorClient: AggregatorClient;                 // lib/src/api/AggregatorClient.js
    client: StateTransitionClient;                       // lib/src/StateTransitionClient.js
    trustBase: RootTrustBase;                            // RootTrustBase.fromJSON(per-network json)
    predicateVerifier: PredicateVerifierService;         // .create()
    mintJustificationVerifier: MintJustificationVerifierService; // .register(new SplitMintJustificationVerifier(...))
    networkId: NetworkId;
    signingService: SigningService;                      // new SigningService(privKey)
  }) {}
  // stateless w.r.t. wallet data; identity = signingService.publicKey
}
```
`oracle/UnicityAggregatorProvider` builds these (the SDK boundary) and hands them to the engine; `decodePaymentData = SpherePaymentData.fromCBOR`.

### A.6 `FakeTokenEngine`
In-memory, deterministic impl of `ITokenEngine` for parallel dev + the contract suite: derives the **real** `deriveIdentityAddress` (so golden vector matches) and the real predicate/balance encodings; fakes only the aggregator round-trips (mint/transfer/split return locally-constructed `SphereToken`s with deterministic ids). Shipped in Phase 0.

### A.7 Boundary enforcement
- ESLint `no-restricted-imports`: ban `@unicitylabs/state-transition-sdk` outside `token-engine/`.
- CI grep also catches `await import('@unicitylabs/...')` and v2 type names (`MintTransaction`, `EncodedPredicate`, …) leaking outside `token-engine/`.

---

## Part B — v2 flows (sender-driven sequences)

### B.1 MINT → `engine.mint`
```
1. recipient = SignaturePredicate.create(recipientChainPubkey)
2. data      = await new SpherePaymentData(assets).encode()                     // coinId→amount (optional)
3. tx        = await MintTransaction.create(networkId, recipient, data, TokenType.generate(), TokenSalt.generate(), justification?)
              // tokenId = TokenId.fromSalt(networkId, salt) = SHA256(CBOR[salt, networkId.id])
4. cert      = await CertificationData.fromMintTransaction(tx)                  // builds the mint unlock script
5. resp      = await client.submitCertificationRequest(cert)                    // SUCCESS | STATE_ID_EXISTS
6. proof     = await waitInclusionProof(client, trustBase, predicateVerifier, tx)
7. certTx    = await tx.toCertifiedTransaction(trustBase, predicateVerifier, proof)
8. token     = await Token.mint(trustBase, predicateVerifier, mintJustificationVerifier, certTx)
9. return SphereToken{ sdkToken: token, blob: encodeToken(token), … }
```

### B.2 TRANSFER → `engine.transfer` — SENDER does everything
```
1. recipient = SignaturePredicate.create(recipientChainPubkey)
2. stateMask = crypto.getRandomValues(new Uint8Array(32))
3. tx        = await TransferTransaction.create(token.sdkToken, recipient, stateMask, data?)
4. unlock    = await SignaturePredicateUnlockScript.create(tx, signingService)   // signs SHA256(sourceStateHash‖txHash)
5. cert      = await CertificationData.fromTransaction(tx, unlock)
6. resp      = await client.submitCertificationRequest(cert)
7. proof     = await waitInclusionProof(client, trustBase, predicateVerifier, tx)
8. certTx    = await tx.toCertifiedTransaction(trustBase, predicateVerifier, proof)
9. updated   = await token.sdkToken.transfer(trustBase, predicateVerifier, certTx)   // returns NEW Token
10. transport.sendToken(recipientNostrPubkey, updated.toCBOR())                       // hand over FINISHED token
```
Granular split: `buildTransfer`(1–3) → `toCertificationData`+`submit`(4–6) → `awaitProof`+`certifyTransfer`+`appendTransfer`(7–9). Used by split/background.

### B.3 RECEIVE — passive
```
1. token = await Token.fromCBOR(bytes)
2. (optional) token.verify(trustBase, predicateVerifier, mintJustificationVerifier) === OK
3. store via TokenStorageProvider.   // proofs embedded; nothing to finalize
```
**Deleted vs v1** (no receiver machinery):
| v1 component | status | why |
|---|---|---|
| `InstantSplitProcessor` (V5 receive) | DELETE | sender sends finished tokens |
| V5/V6 receive-bundle handling | DELETE | no receiver-side submit |
| `resolveUnconfirmed()` for **incoming** | DELETE | no unconfirmed receive state |
| `loadPendingV5Tokens` | DELETE | no pending receive tokens |
| `transaction→transition` import resolution | DELETE | recipient predicate is fully specified by sender |
| `ReceiveOptions.{finalize,timeout,pollInterval,onProgress}` | DELETE | async finalize gone |

### B.4 SPLIT → `engine.split`
```
1. requests = outputs grouped into [TokenId(child), PaymentAssetCollection][]   // child tokenId from each mint's salt+networkId
2. split   = await TokenSplit.split(token.sdkToken, SpherePaymentData.fromCBOR, requests)
            // → { burn:{ ownerPredicate: BurnPredicate, transaction: TransferTransaction }, proofs: Map<TokenId, SplitAssetProof[]> }
3. burn    : cert = CertificationData.fromTransaction(split.burn.transaction, unlock); submit; awaitProof; token.transfer(certBurn) → burntToken
4. per out : just  = SplitMintJustification.create(burntToken, split.proofs.get(tid)).toCBOR()
             mintTx= await MintTransaction.create(networkId, recipientPredicate, paymentData, tokenType, salt, just)
             → CertificationData.fromMintTransaction → submit → awaitProof → toCertifiedTransaction → Token.mint
5. conservation enforced inside TokenSplit: SparseMerkleSumTree root.value === asset.value, else TokenAssetValueMismatchError
```

### B.5 Latency / Spike S1
Sender waits for the inclusion proof **synchronously** (~2.3 s/op; split ≈ (N+1)×2.3 s). This is **not** the old "return fast + background-finish." S1 decides the send UX: (a) accept sync-wait; (b) **sender-side** background-submit + persist a pending-send job + notify on proof (NB: a *sender* job, not the deleted *receiver* `resolveUnconfirmed`); (c) batch proofs. Decide + measure in A3.

---

## Part C — Caller migration (per-file)

> Pattern for every file: route old-SDK calls through `ITokenEngine` (the only SDK importer). Below: current old symbols → what changes → what is deleted → acceptance. **Owner tags:** [P1]=Track A, [P2]=Track B.

### C.1 `modules/payments/PaymentsModule.ts` — [P2] (HIGH)
- **Old symbols:** `Token`, `TokenState`, `TokenType`, `TransferCommitment`, `MintCommitment`, `MintTransactionData`, `InclusionProof`, `CoinId`, `AddressScheme`, `UnmaskedPredicate`, `SigningService`, `waitInclusionProof`, `StateTransitionClient`, `RootTrustBase`; dyn `ProxyAddress`/`UnmaskedPredicateReference`/`TokenId`/`TokenCoinData`.
- **Changes:** `send()` → full sender flow via `engine.transfer` / `engine.split`. Balance/coin reads (`SdkToken.fromJSON`/`coins.get`) → `engine.balanceOf`/`engine.decodeToken`. `parseTokenInfo` → `engine.decodeToken`.
- **Delete:** `resolveUnconfirmed`, `scheduleResolveUnconfirmed`, `stopResolveUnconfirmedPolling`, `loadPendingV5Tokens`; the `InstantSplitProcessor` usage; async `ReceiveOptions` fields. **Gut** `handleIncomingTransfer` → store-only (keep nametag recording).
- **Keep:** public API (`send/receive/getTokens/getBalance/...`) signatures (D4); `SpendQueue`/reservation wiring.
- **Accept:** `send()` does the end-to-end sender flow; no receiver polling loops; incoming tokens stored immediately; unit tests (engine mocked) green; no SDK import.

### C.2 `modules/payments/InstantSplitExecutor.ts` — [P2] (HIGH)
- **Old:** `TokenSplitBuilder`, `TokenCoinData`, `CoinId`, `TransferCommitment`, `MintCommitment`, `MintTransactionData`, `UnmaskedPredicate(Reference)`, `waitInclusionProof`.
- **Changes:** rebuild onto `TokenSplit.split` via `engine.split` (or fold into `PaymentsModule.send`). The "build bundle, receiver finishes" design is gone — sender mints+transfers all outputs and hands finished tokens over. `submitBackgroundV5` (transfer half) removed.
- **Accept:** produces finished output tokens via the engine; no V5 bundle returned.

### C.3 `modules/payments/InstantSplitProcessor.ts` — [P2]
- **DELETE the file** (receiver-side V5 processing). No cross-version interop (D1). If a legacy shim is ever needed, isolate under `legacy/` and mark deprecated.

### C.4 `modules/payments/TokenSplitExecutor.ts` — [P2]
- **Old:** `TokenSplitBuilder`, `TokenState`, `CoinId`, `TokenCoinData`, `TransferCommitment`, `waitInclusionProof`.
- **Changes:** rewrite the conservative split onto `engine.split` (same sender-driven sequence; no commitments).

### C.5 `modules/payments/TokenRecoveryService.ts` — [P2] (MED)
- **Old:** `Token`, `TokenId`, `TokenState`, `TokenType`, `CoinId`, `UnmaskedPredicate`, `SigningService`, `StateTransitionClient`, `RootTrustBase`.
- **Changes:** **simplify to SENDER-side only** — a sender's own pending mint/transfer whose proof didn't land. Reconstruct via the engine granular steps. Receiver-side orphan recovery is gone.

### C.6 `modules/payments/BackgroundCommitmentService.ts` — [P2] (MED)
- **Old:** `MintCommitment`/`TransferCommitment` (types), `StateTransitionClient`, `RootTrustBase`.
- **Changes:** **rewrite or DELETE** depending on S1. If S1 = background-send, this becomes a SENDER-side `submit + awaitProof` job queue over the engine; else remove.

### C.7 `modules/payments/SpendQueue.ts` — [P2] (LOW-MED)
- **Old:** `Token` (`fromJSON`), `CoinId` (`coins.get`).
- **Changes:** value reads → `engine.balanceOf` / `engine.decodeToken` (v2 has no `coins.get`/`fromJSON`). **Queue/reservation logic (sync critical section, `TokenReservationLedger`) unchanged.**

### C.8 `modules/payments/TokenSplitCalculator.ts` — [P2] (LOW-MED)
- **Old:** `Token` (`fromJSON`), `CoinId` (`coins.get`).
- **Changes:** value reads → `engine.balanceOf`. Split-plan math unchanged.

### C.9 `modules/payments/NametagMinter.ts` — [P2]
- **Old:** `Token`, `TokenId.fromNameTag`, `MintTransactionData.createFromNametag`, `MintCommitment`, `UnmaskedPredicate`, `DirectAddress`, `waitInclusionProof`.
- **Changes:** **retire the on-chain mint** (D5). Nametag = Nostr binding (name↔pubkey). Keep only the Nostr publish/resolve path; remove all SDK mint calls.

### C.10 `modules/accounting/AccountingModule.ts` — [P2] (HIGH)
- **Old:** `Token` (`fromJSON`); dyn `TokenId`, `TokenType`, `MintTransactionData`, `MintCommitment`, `SigningService`, `HashAlgorithm`, `DataHasher`, `UnmaskedPredicate(Reference)`, `TokenState`, `waitInclusionProof`; `getStateTransitionClient()`.
- **Changes:** invoice mint → `engine.mint`; import/verify → `engine.verify`; token parse/balance → `engine.decodeToken`/`balanceOf`. `txfToToken`/`tokenToTxf` → TokenBlob (Part D). Invoice token-id via engine hash helper. Public invoice API frozen (D4).

### C.11 `validation/token-validator.ts` — [P2]
- **Old:** `Token` (`fromJSON`); dyn `RequestId`, `DataHash`.
- **Changes:** `verify`/`isSpent` → `engine.verify`/`engine.isSpent` (v2 uses `StateId` + `getInclusionProof`, **not** `RequestId`).

### C.12 `oracle/UnicityAggregatorProvider.ts` — [P1] (MED)
- **Old:** `StateTransitionClient`, `AggregatorClient`, `RootTrustBase`, `Token`, `waitInclusionProof`, `TransferCommitment`.
- **Changes:** **become the engine's SDK boundary** — build v2 clients + `RootTrustBase.fromJSON` + verifiers, expose to `SphereTokenEngine`. Replace `submit*Commitment`/`finalizeTransaction`/`waitForProofSdk` with `submitCertificationRequest` + v2 `waitInclusionProof` arg order.

### C.13 `core/Sphere.ts` — [P2] (identity, B6)
- **Old:** `SigningService`, `TokenType`, `HashAlgorithm`, `UnmaskedPredicateReference`; dyn `ProxyAddress`.
- **Changes:** `deriveL3PredicateAddress` → the ported legacy `DIRECT://` helper in `token-engine/identity/` (Path A). `chainPubkey`/L1 derivation (core/crypto) **unchanged** (proven stable). Remove `ProxyAddress` (nametag → Nostr).

### C.14 `transport/NostrTransportProvider.ts` — [P2] (B4/B6)
- **Old:** dyn `ProxyAddress` (nametag resolution).
- **Changes:** remove `ProxyAddress`; `@name` resolves via the Nostr binding to `chainPubkey`. `publishIdentityBinding` keeps `directAddress` (Path A); preserve the anti-bot gate.

### C.15 Untouched
`modules/swap/*` (uses payments/accounting facades — add an acceptance test the facade still passes), `modules/communications/*`, `modules/groupchat/*`, `modules/market/*`, `l1/*`, `price/*`, `registry/*`, `storage/*` interfaces.

---

## Part D — Serialization & storage — [P1] (A5)

### D.1 `TokenBlob` (replaces TXF JSON)
v2 is CBOR-only; the storage blob = CBOR-hex of the v2 `Token` + a small JSON header for fast list/UI:
```ts
interface TokenBlob {
  schemaVersion: '3';                 // bumped from TXF '2.0'
  tokenId: string;                    // hex(TokenId.bytes)
  coinId: string; amount: string; symbol: string;   // UI cache (amount = BigInt string)
  status: 'confirmed' | 'pending';
  createdAt: number; updatedAt: number;
  cbor: string;                       // hex of Token.toCBOR()
}
```
`serialization/txf-serializer.ts`:
| old function | new behavior |
|---|---|
| `normalizeSdkTokenToStorage` | **removed** (no JSON bytes-objects anymore) |
| `tokenToTxf` | → **`tokenToBlob(token): TokenBlob`** (Token.toCBOR + header) |
| `txfToToken` | → **`blobToToken(blob): SphereToken`** (Token.fromCBOR + decodePaymentData) |
| `buildTxfStorageData` / `parseTxfStorageData` | read/write `TokenBlob` keyed `_<v2 tokenId>` + version gate |
| (new) | `readBlobMetadata(blob)` — header-only fast path, no CBOR parse |
`types/txf.ts`: deprecate `TxfToken`, add `TokenBlob`.

### D.2 Wipe-not-migrate (D1) + storage providers
```ts
function assertBlobV3(b: unknown): asserts b is TokenBlob {
  if (b && ((b as any).version === '2.0' || (b as any).genesis))      // old TXF
    throw new SphereError('OLD_TOKEN_FORMAT', 'v1 token format not supported on v2 — fresh start');
  if ((b as any)?.schemaVersion !== '3') throw new SphereError('INVALID_TOKEN_BLOB', 'expected schemaVersion=3');
}
```
Run on every entry in `parseTxfStorageData`/`load()`. **Reject loudly** (never silent mis-parse).
| provider | change |
|---|---|
| IndexedDB (`IndexedDBTokenStorageProvider`) | store/parse `TokenBlob` in `tokens` store; gate on load |
| File (`FileTokenStorageProvider`) | `{tokenId}.json` = `TokenBlob`; gate on load |
| IPFS (`ipfs-storage-provider` + `txf-merge`) | publish/parse `TokenBlob`; **merge dedups by `tokenId` only** (v2 tokens immutable) — drop the `tokenId:stateHash` composite-key logic (~30 lines): |
```ts
// new merge:
const id = blob.tokenId;
if (tombstoneIds.has(id)) { removed++; continue; }
```

---

## Part E — Test plan & merge gate — [P1 engine] + [P2 callers/identity]

### E.1 Levels
- **Unit** — mock the **`ITokenEngine` port**, not the SDK. Rewrite the ~14 SDK-mocking tests: `AccountingModule.*` (createInvoice/minting/importInvoice/deliveryOrders/validation/storage/errors), `PaymentsModule.*` (tokenTransfers/history/history-sync/history-integration/v5-finalization/tombstone), `TokenSplitCalculator`, `NametagMinter`. New helper:
```ts
export function createMockTokenEngine(): ITokenEngine { return {
  deriveIdentityAddress: vi.fn(() => 'DIRECT://…'),
  deriveReceivePredicate: vi.fn(),
  balanceOf: vi.fn(() => 100n),
  readPaymentData: vi.fn(),
  mint: vi.fn().mockResolvedValue(mockSphereToken()),
  transfer: vi.fn().mockResolvedValue(mockSphereToken()),
  split: vi.fn().mockResolvedValue({ burn:{}, outputs:[] }),
  verify: vi.fn().mockResolvedValue({ ok:true }), isSpent: vi.fn().mockResolvedValue(false),
  encodeToken: vi.fn(), decodeToken: vi.fn(), /* …granular… */ } as unknown as ITokenEngine; }
```
- **Contract** — `tests/unit/token-engine/ITokenEngine.contract.test.ts`: run the same suite against `FakeTokenEngine` and `SphereTokenEngine`; assert identical results (esp. golden-vector `deriveIdentityAddress`, balance, payment-data round-trip).
- **Property** — `TokenBlob` round-trip idempotent; split value-conservation (`Σ outputs == source`); IPFS merge dedup.
- **e2e** — `tests/e2e/gateway-v2.test.ts` on `gateway-test.unicity.network`: mint → transfer → receive → split → verify; assert `blob.schemaVersion==='3'`.
- **Identity (XP-critical)** —
```ts
it('golden vector: fixed mnemonic → v0.7.2 DIRECT://', () => {
  expect(engine.deriveIdentityAddress({ chainPubkey: GOLD.pubkey })).toBe(GOLD.directAddress); // recorded from v1.6.1 before removal
});
it('chainPubkey stable: elliptic ≡ @noble ≡ v2 SigningService', () => { /* same priv → same 33B pubkey */ });
it('sphere-api XP login keeps progress (Path A)', async () => { /* legacy DIRECT:// → same walletAddress → same XP */ });
it('bot without Nostr binding is rejected', async () => { /* anti-bot gate */ });
```

### E.2 Merge gate (all required, CI)
| # | check |
|---|---|
| 1 | `npm run test:run` green (engine + rewritten mocks + new TokenBlob/identity tests) |
| 2 | Contract suite: `FakeTokenEngine` ≡ `SphereTokenEngine` on golden inputs |
| 3 | Property: round-trip / conservation / merge |
| 4 | **Golden-vector identity address** byte-matches v0.7.2 |
| 5 | `npm run test:e2e` green on testnet |
| 6 | Storage audit: every blob `schemaVersion==='3'`; old format rejected loudly |
| 7 | **chainPubkey stability** cross-check green |
| 8 | **Anti-bot gate** preserved (login without binding fails) |
| 9 | ESLint `no-restricted-imports` + CI grep: zero SDK imports / dynamic-imports / type-leaks outside `token-engine/` |
| 10 | **Public API snapshot unchanged** (frozen surface) |
| 11 | **D-IDENTITY = Path A (decided)**: wallet keeps legacy `DIRECT://`; no sphere-api change; golden-vector + XP-login green |
| 12 | Two reviewers each on A3 (split), A5 (serde), B6 (identity) |
