# Sphere SDK API Reference

> **Upgrading from a release before 0.15.0?** `sphere.paymentsV2` and the `paymentsV2: true` init
> flag were **removed** in 0.15.0: `sphere.payments` is the only accessor, and it **throws**
> `SphereError('NOT_INITIALIZED')` where the alias returned `null` (see
> [Payments](#payments-spherepayments--the-paymentsv2-facade)). 0.15.0 also moved the base SDK pin
> to `@unicitylabs/state-transition-sdk@3.0.1`, a wire break that no 2.x client can straddle; the
> operational consequences are in [Upgrading to 0.15.0](./INTEGRATION.md#upgrading-to-0150) and the
> [0.15.0 changelog entry](../CHANGELOG.md#0150---2026-08-28). Nothing on this page's method
> signatures changed with the pin.

## Sphere

Main entry point for all SDK operations. The constructor is **private** — use static methods to create/load wallets.

### Static Methods

#### `Sphere.init(options: SphereInitOptions): Promise<SphereInitResult>`

Primary entry point. Creates a new wallet or loads an existing one automatically.

```typescript
const { sphere, created, generatedMnemonic } = await Sphere.init({
  storage, transport, oracle,
  network: 'testnet2',       // REQUIRED in practice: 'testnet' | 'testnet2' | 'mainnet'.
                             //   Compared to walletApi.network as an exact STRING — 'testnet'
                             //   vs 'testnet2' is a mismatch (INVALID_CONFIG), alias or not.
                             //   Also selects the token registry for this Sphere.
  walletApi,                 // REQUIRED: the wallet-api transport config
                             //   { network, baseUrl, deviceId?, fetchFn?, webSocketFactory?,
                             //     paymentsV2Transport? } — createWalletApiProviders builds it —
                             //   or the literal 'none' for a messaging-only wallet (see below).
                             //   Omitting it throws INVALID_CONFIG (money moves only through
                             //   the wallet-api vertical)
  autoGenerate: true,        // Generate a mnemonic if no wallet exists
  mnemonic: 'words...',      // Or a mnemonic to create from (ignored when a wallet exists)
  password: 'secret',        // Optional: encrypt mnemonic (plaintext if omitted)
  nametag: 'alice',          // Optional: register @alice on create
  price: priceProvider,      // Optional PriceProvider
  derivationPath: "m/44'/0'/0'", // Optional custom path
  dmSince: Math.floor(Date.now() / 1000) - 86400, // Optional DM history fallback (unix seconds);
                             //   currently does not take effect with the bundled Nostr
                             //   transport — see "DM history on connect" below

  groupChat: true,           // Optional: NIP-29 group chat — true = network-default relays,
                             //   or a GroupChatModuleConfig. Omit and sphere.groupChat is null
  market: true,              // Optional: market intents — true | MarketModuleConfig.
                             //   Omit and sphere.market is null
  communications: { maxPerConversation: 200 },  // Optional CommunicationsModuleConfig
  discoverAddresses: true,   // Optional: scan Nostr bindings for previously used HD addresses.
                             //   ON by default (autoTrack: true) whether init creates or
                             //   loads the wallet; false disables it. A failed scan is logged,
                             //   not thrown. true | false | DiscoverAddressesOptions
  verification: { createWorker },  // Optional: opt in to PARALLEL token verification —
                             //   { createWorker, poolSize? }, where createWorker spawns YOUR
                             //   bundled worker entry script. Omit for the sequential
                             //   verifier. See docs/VERIFICATION-WORKERS.md
  debug: true,               // Optional: debug logging. The flag is process-global — an
                             //   explicit false turns it off, omitting it leaves it as-is
  onProgress: (p) => console.log(p.step, p.message), // Optional: init progress callback
});
```

**`network` is required even though the type marks it optional.** `Sphere.init` resolves the
payments composition first, and that resolution throws `INVALID_CONFIG` unless `network` is a
known network AND string-equal to `walletApi.network` — so all three of
`createBrowserProviders`/`createNodeProviders`, the `walletApi` config, and `Sphere.init` must
carry the *same literal*. The provider factories do not return `network` in their bundle, so
spreading `{ ...providers }` does not supply it. `Sphere.create`, `Sphere.load` and
`Sphere.import` take the same option and enforce the same rule.

**Messaging-only wallets: `walletApi: 'none'`.** A wallet that only messages (DMs, group chat,
nametags) passes `walletApi: 'none'` (the exported constant `NO_PAYMENTS`). It composes no money:
no wallet-api session, no token engine, no payments state. `network` is still required, because
it selects the token registry and the group-chat relays. `sphere.hasPayments` is then `false`, and
`sphere.payments` throws `PAYMENTS_NOT_COMPOSED`. Leaving `walletApi` out altogether still throws
`INVALID_CONFIG`, and so does any other string. Shipped in 0.17.3; see
[the setup example](#messaging-only-wallet-walletapi-none).

**An existing wallet wins.** If the storage already holds a wallet, `Sphere.init` loads it and
ignores `mnemonic`, `nametag` and `autoGenerate`. To replace the stored wallet with another phrase,
use [`Sphere.import`](#sphereimportoptions-sphereimportoptions-promisesphere) with `overwrite: true`,
which then clears the storage's current wallet first; without that flag `Sphere.import` rejects with
`ALREADY_INITIALIZED` and leaves the wallet untouched.

**Removed options:** `accounting: true` / `swap: true` still **throw** a typed `INVALID_CONFIG`,
deliberately: invoicing and swaps no longer exist in the SDK, and a silently ignored option would
hide that. `paymentsV2: true` was a deprecated no-op and is **gone in 0.15.0** — passing it
is an excess-property error against `SphereInitOptions`, not a runtime refusal. `tokenStorage` /
`delivery` no longer exist (token custody is the wallet-api backend).

**Password encryption behavior:**
- **No password (default):** Mnemonic stored as plaintext in storage.
- **Password provided on create/import:** the mnemonic (or master key) is encrypted before it is
  stored, with CryptoJS's password-based AES-256-CBC (`CryptoJS.AES.encrypt(data, password)`: key
  and IV from OpenSSL's `EVP_BytesToKey` with MD5, one iteration, a random 8-byte salt, no MAC).
- **Password provided on load:** Decrypts the stored mnemonic. A wrong or missing password on a
  mnemonic wallet throws `SphereError` `STORAGE_ERROR` `'Failed to decrypt mnemonic'`.
- **Backwards compatibility:** Wallets encrypted with older SDK versions (internal default key) load correctly without a password.

The key derivation is fast, so the password keeps the phrase out of casual view and out of storage
copies read without it, but anyone who obtains the stored value can try passwords offline at high
speed: a short or common password gives little protection. The other stored data (derivation path,
nametags, payment journals) is not protected by the password either way. Set a long, unique
password for wallets that hold value, and protect the storage itself at the operating-system level.
The password is fixed when the seed is stored; there is no call to add or change it later.
`Sphere.importFromJSON` and `Sphere.importFromLegacyFile` use their `password` only to decrypt the
backup and store the imported seed **without** a password.

#### `Sphere.exists(storage: StorageProvider): Promise<boolean>`

Check if wallet data exists in storage. A storage that cannot be opened or read answers `false`
here; `Sphere.init`, `Sphere.create` and `Sphere.import` run the same check *without* that catch,
so a failing store rejects with its own error there instead of being taken for an empty one.
`Sphere.load` still uses the catching check, so a store it cannot read looks empty and `load`
rejects with `NOT_INITIALIZED`.

#### `Sphere.create(options: SphereCreateOptions): Promise<Sphere>`

Create wallet from a known mnemonic (low-level; prefer `Sphere.init()`).

#### `Sphere.load(options: SphereLoadOptions): Promise<Sphere>`

Load existing wallet from storage (low-level; prefer `Sphere.init()`).

`create`, `load` and `import` resolve the `Sphere` itself, not `{ sphere }`. `create` refuses when
the storage already holds a wallet (`ALREADY_INITIALIZED`), and so does `import` unless
`overwrite: true` is passed; `load` refuses when it holds none (`NOT_INITIALIZED`). All of them
need `storage`, `transport`, `oracle`, `walletApi` and `network`.

#### `Sphere.import(options: SphereImportOptions): Promise<Sphere>`

Import a wallet from a `mnemonic`, or from a `masterKey` (with optional `chainCode`, `basePath` and
`derivationMode`); throws `INVALID_CONFIG` when neither is given. Every input is checked before the
storage is touched: a missing or unknown `network`, and a `password` of `''`, throw
`INVALID_CONFIG`; an invalid mnemonic, and a `masterKey` or a non-empty `chainCode` that is not 64
hex characters, throw `INVALID_IDENTITY`. **When a wallet already exists in that storage**, or a
live Sphere is registered on that storage object, it rejects with `ALREADY_INITIALIZED` and leaves
the wallet untouched, unless you pass `overwrite: true`. An import into a storage that holds no
wallet needs no flag.

`overwrite: true` clears that wallet first (keys, identity and the `pv2g2:*` payment journals,
including those of transfers still in flight): see `Sphere.clear()` below. Do not run it while
transfers are pending, and back up the current recovery phrase first — the clear runs before the new
wallet is brought up, so a failure after it (unreachable relays, a `nametag` already taken) leaves
the new wallet's keys stored and the old wallet gone. To keep both wallets, import into other
storage instead: on Node another `walletFileName` or `dataDir` (see
[`listWallets()`](#base-providers-platform-specific)), in the browser another `dbName`.

#### `Sphere.importFromJSON(options): Promise<{ success: boolean; sphere?: Sphere; mnemonic?: string; error?: string }>`

Restore from an `exportToJSON()` backup. `options` are the `Sphere.import` options without the key
fields — `overwrite` is still one of them — plus `jsonContent: string` and `password?: string` (to
decrypt an encrypted backup). It never throws: bad input, a wrong password and errors from
`Sphere.import` all come back as `{ success: false, error }`. That covers the refusal over a
storage that already holds a wallet — `error` is then `'A wallet already exists on this storage.
Pass overwrite: true to replace it, ...'`, the `ALREADY_INITIALIZED` code is not returned, and
nothing is erased. Keep `result.sphere`: it is the live instance, built on the storage you passed.
The restored seed is stored **without** a password (the `password` only decrypts the backup).

#### `Sphere.importFromLegacyFile(options): Promise<{ success: boolean; sphere?: Sphere; mnemonic?: string; needsPassword?: boolean; error?: string }>`

Restore from a backup file: an `exportToTxt()` text backup (optionally password-encrypted), an
`exportToJSON()` file, a legacy flat-JSON webwallet export, or a bare mnemonic in a text file.
`options` add `fileContent: string`, `fileName: string` (used for type detection), `password?` and
`onDecryptProgress?` to the key-less `Sphere.import` options. `needsPassword: true` means the file is
encrypted and no password was given. Unlike `importFromJSON`, for a text backup, a legacy
flat-JSON export or a bare mnemonic, an error thrown by `Sphere.import` itself (for example a
missing `network`, or `ALREADY_INITIALIZED` when the storage already holds a wallet and
`overwrite: true` was not passed) rejects instead of coming back as `{ success: false }`. An
`exportToJSON()` file is handed to `importFromJSON` and comes back as `{ success: false, error }`.
The restored seed is stored without a password, as with `importFromJSON`.

#### `Sphere.clear(options: { storage: StorageProvider }): Promise<void>`

Delete all SDK-owned wallet data: the KV store (keys, identity, and the `pv2g2:*` payment
journals). In the browser it also sweeps orphaned pre-flip `sphere-token-storage-*`
IndexedDB databases.

This is a wipe, not a migration step: it clears the store with no prefix, so it takes the
mnemonic with it. The 0.15.0 scoped-KV generation bump needs nothing from you — the superseded
`pv2:` keys are swept once when the vertical is composed.

```typescript
await Sphere.clear({ storage: providers.storage });
```

**It destroys live Spheres — scoped by BACKING STORE, not by provider object.** Before wiping,
`clear()` calls `destroy()` on every live `Sphere` built on the store `storage` addresses: the
payments vertical stops, providers disconnect, and every `sphere.on()` handler goes with them.
Those instances are dead afterwards; hold no references across a `clear()`.

Which instances that covers is decided by
[`StorageProvider.backingStoreId`](./INTEGRATION.md#storage-provider-interface). Two provider
objects that report the same value address the same data, so clearing through either destroys
the Spheres of both — the bundled providers report one (resolved wallet path for
`FileStorageProvider`; the `dbName` alone for `IndexedDBStorageProvider`; the `Storage`
object + prefix for `LocalStorageProvider`). A provider that declares none is scoped to itself,
so a second object over the same data is treated as unrelated. A Sphere on *other* storage is
never touched.

**IndexedDB: the unit is the whole database, not the key prefix.** Every `prefix` inside one
IndexedDB database (`dbName`) belongs to one backing store, and `clear()` empties the whole
database. Clearing through one prefix, or importing with `overwrite: true` through a prefix that
already holds a wallet (or through a storage object a live Sphere is using), therefore destroys the
Spheres of every prefix in that database and wipes their keys, mnemonic included. An import into an
unused prefix does not clear anything, and neither does one without `overwrite: true`. Give each
wallet its own `dbName`; a separate `prefix` alone does not isolate two wallets.

`Sphere.import(options)` with `overwrite: true` inherits all of this: it calls
`Sphere.clear({ storage })` first whenever a wallet exists on that storage or a live Sphere is
registered on that storage object, so importing over storage B tears down the Spheres on B's
backing store (for IndexedDB, every prefix in B's database) — and only those. Without
`overwrite: true` it rejects with `ALREADY_INITIALIZED` in exactly those cases and clears nothing.

**It also refuses an `init` / `create` / `load` / `import` that is in flight on that store.** A
wallet being built is not yet registered, so `clear()` cannot destroy it; instead the bring-up
checks at the very end whether the store was cleared under it and, if so, tears itself down and
rejects with a `SphereError` of code `STORAGE_ERROR` rather than handing back a ready Sphere
over an emptied KV. Retry the init once the clear has settled — it is a fresh wallet by then,
so `Sphere.init` reports `created: true`.

### Properties

| Property | Type | Description |
|----------|------|-------------|
| `identity` | `Identity \| null` | Current wallet identity (after init/load): `chainPubkey`, `directAddress`, `ipnsName`, `nametag`. Public data only; the private key is never exposed |
| `isReady` | `boolean` | Whether this Sphere is initialized. `true` once `init`/`create`/`load`/`import` has finished building it; back to `false` after `destroy()` |
| `networkId` | `number \| undefined` | The active network id, read from the oracle's root trust base (`RootTrustBase.networkId` — testnet2 = `4`, mainnet = `1`). `undefined` when the oracle has no trust base |
| `payments` | `PaymentsV2` | The payments facade (assets/tokens/history/send/mint/receive/requests). **Throws** `NOT_INITIALIZED` while no vertical runs — init in flight, mid address-switch, or destroyed — and `PAYMENTS_NOT_COMPOSED` (permanent) on a wallet built with `walletApi: 'none'` |
| `hasPayments` | `boolean` | Whether this Sphere composes money at all: `false` exactly when it was built with `walletApi: 'none'`. Fixed for the instance's life; not a liveness check (`true` still leaves `payments` throwing `NOT_INITIALIZED` mid-init or mid-switch) |
| `communications` | `CommunicationsModule` | Messaging operations |
| `groupChat` | `GroupChatModule \| null` | NIP-29 group chat (null unless enabled) |
| `market` | `MarketModule \| null` | Market intents (null unless enabled) |

`isReady` is the replacement for the removed `Sphere.isInitialized()` static. `Sphere.getInstance()`,
`Sphere.isInitialized()` and the `getSphere` export are **gone** — hold the instance the entry point
returned and read `sphere.isReady` on it. There was never a safe deprecation: once a second Sphere
had been created *and* destroyed, `getInstance()` answered `null` while the first was alive and
serving money. See [MIGRATION-TOKEN-REGISTRY.md](./MIGRATION-TOKEN-REGISTRY.md#also-removed-the-sphere-lifecycle-globals).

### Instance Methods

#### `signMessage(message: string): string`

Sign an arbitrary message using the wallet's private key (secp256k1 ECDSA with recoverable signature).

Returns a 130-character hex string: `v` (2 chars) + `r` (64 chars) + `s` (64 chars). The recovery byte `v = 31 + recoveryParam`.

```typescript
const signature = sphere.signMessage('Sign in to My App\n\nNonce: abc123');
// → '1f3a5b7c...' (130 hex chars)
```

The private key never leaves the SDK. Use `verifySignedMessage()` to verify on the server side.

#### `destroy(): Promise<void>`

Cleanup and disconnect all providers.

#### `exportToJSON(options?: WalletJSONExportOptions): WalletJSON`

A JSON backup (`{ includeMnemonic?, password?, addressCount? }`), which
`Sphere.importFromJSON` restores — onto a storage that already holds a wallet, only with
`overwrite: true`. With `password`, the mnemonic and master private key are encrypted with the same
CryptoJS scheme as the stored seed; without it they are exported in **plaintext**.

#### `exportToTxt(options?: { password?: string; addressCount?: number }): string`

The `UNICITY WALLET DETAILS` text backup of the master private key, which
`Sphere.importFromLegacyFile` restores — onto a storage that already holds a wallet, only with
`overwrite: true`. With `password`, the key is encrypted (PBKDF2-SHA1 with 100,000 iterations and a
fixed salt, then CryptoJS AES); without it, it is written in plaintext.

#### `getMnemonic(): string | null`

The recovery phrase, or `null` for a wallet imported from a master key.

#### `on<T extends SphereEventType>(type: T, handler: SphereEventHandler<T>): () => void`

Subscribe to events. Returns unsubscribe function. Type-safe — see `SphereEventMap` for event payloads.

#### `deriveAddress(index: number, isChange?: boolean): AddressInfo`

Derive the key material at a specific HD index. The result is
[`AddressInfo`](#addressinfo) = `{ privateKey, publicKey, path, index }`: it has **no address
field**, and it holds the private key, so never log or serialise the whole object. For the
`DIRECT://` address use `sphere.identity?.directAddress` (active address) or
`sphere.getTrackedAddress(index)?.directAddress` (after `switchToAddress(index)`). The DIRECT
address cannot be computed from `publicKey`: it derives from a hash of the private key.

```typescript
// Derive the first receiving address's keys
const addr0 = sphere.deriveAddress(0);
console.log(addr0.publicKey, addr0.path); // compressed chain pubkey (hex), full BIP32 path

// Derive change address
const change = sphere.deriveAddress(0, true);
```

#### `deriveAddressAtPath(path: string): AddressInfo`

Derive address at a full BIP32 path.

```typescript
const addr = sphere.deriveAddressAtPath("m/44'/0'/0'/0/5");
```

#### `deriveAddresses(count: number, includeChange?: boolean): AddressInfo[]`

Derive multiple addresses starting from index 0.

```typescript
// Get first 5 receiving addresses
const addresses = sphere.deriveAddresses(5);

// Get 5 receiving + 5 change addresses
const allAddresses = sphere.deriveAddresses(5, true);
```

#### `getBasePath(): string`

Get the base derivation path (default: `m/44'/0'/0'`).

#### `getDefaultAddressPath(): string`

Get the default address path (`m/44'/0'/0'/0/0`).

#### `hasMasterKey(): boolean`

Check if wallet has BIP32 master key for HD derivation.

#### `getCurrentAddressIndex(): number`

Get the current active address index.

#### `switchToAddress(index: number, options?: { nametag?: string }): Promise<void>`

Switch the active identity to a different HD-derived address. Automatically tracks the address in the registry.

```typescript
await sphere.switchToAddress(1);
console.log(sphere.getCurrentAddressIndex()); // 1
console.log(sphere.identity!.directAddress);  // DIRECT://... (address at index 1)
```

`index` must be a uint32 (see [`TrackedAddressEntry`](#trackedaddressentry)); anything else
throws `INVALID_CONFIG` before anything is derived, tracked or written. `options.nametag` names a
Unicity ID for the address being switched to; it must be valid and not yet taken, or the call
throws `VALIDATION_ERROR`.

#### `getActiveAddresses(): TrackedAddress[]`

Get all non-hidden tracked addresses, sorted by index.

```typescript
const addresses = sphere.getActiveAddresses();
for (const addr of addresses) {
  console.log(`#${addr.index}: ${addr.directAddress} (${addr.nametag ?? 'no nametag'})`);
}
```

#### `getAllTrackedAddresses(): TrackedAddress[]`

Get all tracked addresses including hidden ones, sorted by index.

#### `getTrackedAddress(index: number): TrackedAddress | undefined`

Get a single tracked address by HD index.

#### `setAddressHidden(index: number, hidden: boolean): Promise<void>`

Hide or unhide a tracked address. Hidden addresses are excluded from `getActiveAddresses()`.

```typescript
await sphere.setAddressHidden(1, true);   // hide
await sphere.setAddressHidden(1, false);  // unhide
```

#### `resolve(identifier: string): Promise<PeerInfo | null>`

Resolve any identifier to full peer information. Delegates to the transport provider.

```typescript
// By nametag
const byNametag = await sphere.resolve('@alice');

// By DIRECT address
const byDirect = await sphere.resolve('DIRECT://000059756bc9c2e4c...');

// By chain pubkey (33-byte compressed, 02/03 prefix)
const byChainPubkey = await sphere.resolve('025412bda2c5b5a15a891c6...');

// By transport pubkey (32-byte hex)
const byTransportPubkey = await sphere.resolve('a1b2c3d4e5f6...');
```

Returns `PeerInfo`:

```typescript
interface PeerInfo {
  nametag?: string;        // @name if registered
  transportPubkey: string; // 32-byte transport key
  chainPubkey: string;     // 33-byte compressed secp256k1
  directAddress: string;   // DIRECT://... L3 address
  network?: string;        // network the binding declares; always absent on the @nametag and
                           //   DIRECT:// routes today (bindings do not carry one yet)
  timestamp: number;       // Binding event timestamp
}
```

#### Nametags per address

- `getNametag(): string | undefined` / `hasNametag(): boolean` — the active identity's nametag.
- `getNametagForAddress(addressId?: string): string | undefined` — the primary nametag of a
  tracked address. `addressId` is the **short address id** (`'DIRECT_xxxxxx_yyyyyy'`, from
  `TrackedAddress.addressId` or `getAddressId(directAddress)`), not an HD index and not the
  `DIRECT://` string; it defaults to the active address. `getTrackedAddress(i)?.nametag` is
  usually simpler.
- `getNametagsForAddress(addressId?: string): Map<number, string> | undefined` — every nametag of
  that address, keyed by nametag index.
- `getAllAddressNametags(): Map<string, Map<number, string>>` — **deprecated**; keyed by
  `addressId`, then nametag index. Use `getActiveAddresses()` / `getAllTrackedAddresses()`.

#### Address discovery

- `discoverAddresses(options?: DiscoverAddressesOptions): Promise<DiscoverAddressesResult>` —
  scan Nostr identity bindings for previously used HD addresses (`maxAddresses`, `gapLimit`,
  `batchSize`, `onProgress`, `signal`). A direct call tracks what it finds only when you pass
  `autoTrack: true` (the automatic scan at init/load/import passes it). Throws `INVALID_CONFIG`
  without an HD master key or a transport that supports discovery.
- `trackScannedAddresses(entries: Array<{ index: number; hidden: boolean; nametag?: string }>): Promise<void>`
  — bulk-track scanned addresses with their visibility and nametag.

#### Providers and connectivity

- `off<T extends SphereEventType>(type: T, handler: SphereEventHandler<T>): void` — remove a
  handler (`on()` also returns an unsubscribe function).
- `preResolveDM(address: string): Promise<void>` — resolve a recipient ahead of DMs; throws
  `INVALID_RECIPIENT` when it cannot be resolved.
- `setOracleApiKey(apiKey: string): Promise<void>` — apply a new gateway API key to the live
  oracle and rebuild the token engine of the active address only. An address that already has
  an engine in this session (the boot address and every address switched to since) keeps the
  old key when you switch back to it; only an address switched to for the first time after the
  call builds its engine with the new key. To re-key such an address, switch to it and call
  `setOracleApiKey` again. Operations started after the call use the new key; one already in
  flight keeps the old engine, which is then disposed, so an operation still verifying a token
  at that moment fails.
- `setPriceProvider(provider: PriceProvider): void` — takes effect for payments verticals composed
  after the call (the next address switch).
- `getStatus(): SphereStatus`, `reconnect(): Promise<void>` (disconnects and reconnects the
  transport), `disableProvider(providerId: string): Promise<boolean>`,
  `enableProvider(providerId: string): Promise<boolean>`,
  `isProviderEnabled(providerId: string): boolean`, `getDisabledProviderIds(): ReadonlySet<string>`.
- `getStorage(): StorageProvider`, `getTransport(): TransportProvider`,
  `getAggregator(): OracleProvider`.

#### Wallet metadata and statics

- `getWalletInfo(): WalletInfo`, `getDerivationMode(): DerivationMode`.
- `Sphere.validateMnemonic(mnemonic: string): boolean`,
  `Sphere.generateMnemonic(strength?: 128 | 256): string` (128 = 12 words, 256 = 24 words).
- `Sphere.detectLegacyFileType(fileName: string, content: string): LegacyFileType`,
  `Sphere.isLegacyFileEncrypted(fileName: string, content: string): boolean`.

---

## Payments (`sphere.payments` — the PaymentsV2 facade)

The payments vertical (design record, still marked DRAFT: `docs/PAYMENTS-V2-DESIGN.md`). Money custody is the
wallet-api backend: token inventory, transfer intents, the delivery mailbox, history and
payment requests live server-side; the client holds keys and a small per-address durable
KV (`pv2g2:{network}:{chainPubkey}:*` — refresh token, cursors, seen-set, journals). The `g2`
generation is 0.15.0's: the prefix rename IS the migration across the base-SDK wire break, and
the superseded `pv2:` keys are swept once at composition.

**`sphere.paymentsV2` is removed** (0.15.0), together with the `paymentsV2: true` init flag.
`sphere.payments` is the same facade the alias returned, with one behavioural difference that
matters at the call site: where the alias evaluated to `null` while no vertical was running, the
getter **throws** `SphereError` with `code: 'NOT_INITIALIZED'`. Code written as
`sphere.paymentsV2?.tokens() ?? []` no longer compiles under TypeScript (TS2551: `paymentsV2`
does not exist on `Sphere`). In plain JavaScript the property is simply gone, so that expression
now always evaluates to `[]` and hides the wallet's tokens instead of failing. Rename it to
`sphere.payments`, and note that `sphere.payments?.tokens() ?? []` does not degrade: the getter
throws before `?.` is reached. Read the facade only after `Sphere.init()` resolves, or catch that
one code where you used to check for `null`.

### How Transfers Work (sender-driven)

```
  ┌─────────┐  putIntent → engine.transfer/split  ┌──────────┐
  │  Sender  │ ───────────────────────────────────>│ Gateway   │  certify on-chain,
  └────┬─────┘   (durable intent FIRST; per-op     └──────────┘  inclusion proof
       │          signed progress checkpoints)
       │  finished token blob (raw Token.toCBOR()) → recipient's wallet-api MAILBOX
       └────────────────────────────────────────────> Recipient
                     verifies (engine.verify + ownership) BEFORE balance → 'confirmed'
```

- The intent is durable on the server **before** any chain op; a crash at any stage resumes
  the SAME `transferId` inside the facade's start — never a second spend.
- Whole-token transfers use `engine.transfer`; partial amounts use `engine.split`: the source
  is burned in one certified operation, then the recipient output and the change are each
  minted in their own certified operation (the mints run in parallel). The burn and its
  inclusion proof are checkpointed server-side, field-encrypted and signed, before any mint is
  submitted, so an interrupted split resumes from that checkpoint instead of burning again.
- A certified-but-undelivered blob is journaled locally (#621) and re-deposited with a bounded
  poison budget (#517) — `deliveryPending: true` on the result, `transfer:attention` when
  deferred/undeliverable.
- **Requirements:** the oracle must supply a trust base and a gateway URL. Without either, no
  token engine can be built, and `Sphere.init` (like `create`/`load`/`import`) rejects with
  `INVALID_CONFIG` ("payments requires the v2 token engine …") unless the wallet is
  messaging-only (`walletApi: 'none'`). A missing gateway API key does not stop the engine from
  being built: the SDK logs a warning and sends gateway requests without a key. The recipient
  must have a published chain pubkey (otherwise `INVALID_RECIPIENT`).

### `send(req: SendRequest): Promise<TransferResult>`

```typescript
interface SendRequest {
  recipient: string;    // @nametag, hex chain pubkey, or DIRECT:// address
  amount: string;       // Amount in smallest units (decimal string)
  coinId: string;       // The 64-hex coin id
  memo?: string;        // Optional message (recipient-encrypted envelope)
}

interface TransferResult {
  readonly id: string;                       // transferId
  status: 'pending' | 'submitted' | 'confirmed' | 'delivered' | 'completed' | 'failed';
                                             // a resolved send() is only ever 'delivered' or 'confirmed'
  readonly tokens: Token[];
  readonly tokenTransfers: TokenTransferDetail[];  // { sourceTokenId, method: 'direct'|'split' }
  error?: string;
  deliveryPending?: boolean;                 // certified on-chain, mailbox deposit still owed — NOT a failure
  deliveryState?: 'landed' | 'pending-delivery';
}
```

`coinId` is the 64-character hex coin id. To get it from a symbol, call `getCoinIdBySymbol('UCT')` (after
`await TokenRegistry.waitForReady()`, because `Sphere.init` starts the registry load without
waiting for it; it returns `undefined` when the symbol is unknown), or take `coinId` from
`sphere.payments.assets()` for a coin the wallet holds. On mainnet the token registry lists no
fungible coins yet, so the lookup returns `undefined` there.

```typescript
import { TokenRegistry, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';

await TokenRegistry.waitForReady(); // Sphere.init starts the registry load but does not await it
const coinId = getCoinIdBySymbol('UCT'); // string | undefined
if (!coinId) throw new Error('UCT is not in this network\'s token registry');

const result = await sphere.payments.send({ recipient: '@alice', amount: '1000000', coinId });
console.log(result.status);          // 'delivered' (landed), or 'confirmed' (certified, delivery pending)
console.log(result.deliveryPending); // true when certified but delivery deferred (normal)
```

**What a resolved `send()` means.** `send()` resolves only when the payment is sent.
`result.status` is `'delivered'` when it landed in the recipient's mailbox, or `'confirmed'` with
`result.deliveryPending === true` (`deliveryState: 'pending-delivery'`) when the transfer is
certified and delivery is still being retried. That is success, not an error. `send()` never
resolves with `'completed'` or `'failed'`: a failure throws. (`'failed'` appears only on the
`transfer:updated` event for a clean failure.)

**Money-safety on rejection.** Some rejections mean the money may already have left the wallet.
`isPossiblyCommittedSendOutcome(err)` is `true` for exactly these codes: `SEND_SYNC_PENDING`,
`CERTIFICATION_UNCONFIRMED`, `CHECKPOINT_PERSIST_FAILED`, `SPLIT_CHECKPOINT_LOST`,
`CHECKPOINT_TRUSTBASE_MISMATCH` and `SEND_PARTIALLY_COMPLETED`. **Never call `send()` again** for
that payment: a new `send()` gets a new transfer id and pays the recipient a second time. The SDK
finishes the original under its own transfer id (in-process or at the next start); show it as
pending ([`pendingTransfers()`](#pendingtransfers-promisependingtransfer)), and wire any "retry"
button to [`resumeNow()`](#resumenow-promisevoid). A
[`PartialSendConflictError`](#errors) means part of the amount was delivered and is final; only
`err.remainingAmount` is still owed, and may be paid only by a new send of exactly that amount.
When `isPossiblyCommittedSendOutcome(err)` is `false`, the SDK's contract is that nothing left the
wallet.

Clean failures you can branch on: `SEND_INSUFFICIENT_BALANCE` (when funds are pinned by transfers
still converging, the message says how much and points to `pendingTransfers()`),
`INVALID_RECIPIENT` (no published chain pubkey, or a proven different network), `TRANSPORT_ERROR`
(the recipient lookup could not reach the relay), `VALIDATION_ERROR` (for example a malformed or
non-positive amount) and `TRANSFER_CONFLICT` (below).
`INSUFFICIENT_BALANCE` is never thrown by `send()`.

A clean conflict (`TransferConflictError`, code `TRANSFER_CONFLICT`: the source was spent by a
different transaction) demotes the stale source (`suspectedSpent`, excluded from selection,
recoverable by resync) and re-plans, up to `MAX_RESELECT` = 8 times. A whole-token send
(`sendWholeToken` / `sendCoinless`) never re-plans.

```typescript
// Import the error helpers from the same entry point as Sphere (here: the package root).
import { PartialSendConflictError, isPossiblyCommittedSendOutcome } from '@unicitylabs/sphere-sdk';

try {
  const result = await sphere.payments.send({ recipient: '@alice', amount: '1000000', coinId });
  // Resolved means sent: result.status is 'delivered', or 'confirmed' with deliveryPending === true.
  if (result.deliveryPending) show('Sent. Delivery to the recipient is pending and is retried automatically.');
} catch (err) {
  if (err instanceof PartialSendConflictError) {
    // Part of the amount was delivered and is final. Only err.remainingAmount is still owed:
    // if you pay it, do it as a NEW send of exactly that amount, never the original amount.
    show(`Partly sent: ${err.remainingAmount} base units were not sent.`);
  } else if (isPossiblyCommittedSendOutcome(err)) {
    // The money may already have left the wallet. Never call send() again for this payment:
    // the SDK completes it under the same transferId. Show it as pending.
    show('Sent, waiting for confirmation.');
    const pending = await sphere.payments.pendingTransfers(); // rows for a "pending" list
    // A "retry" button calls sphere.payments.resumeNow(), never send().
  } else {
    // Nothing left the wallet. Read `code` structurally: errors thrown by the providers
    // (e.g. the Nostr transport) are a different SphereError class copy, so isSphereError() is false for them.
    const code = (err as { code?: unknown } | null)?.code;
    switch (code) {
      case 'SEND_INSUFFICIENT_BALANCE': show((err as Error).message); break; // names pinned funds when transfers are converging
      case 'INVALID_RECIPIENT': show('Recipient not found'); break;
      case 'TRANSPORT_ERROR': show('Could not look up the recipient. Check the connection.'); break;
      default: show(err instanceof Error ? err.message : String(err));
    }
  }
}
```

**Recipient network.** Nametag bindings do not carry a network yet, so the SDK cannot prove that a
`@nametag` or `DIRECT://` recipient uses your network. Every such send emits `transfer:attention`
with `code: 'recipient:network-unverified'` and an empty `transferId`, and then proceeds on your
network. Treat it as information, not an error; on mainnet, make sure the recipient runs mainnet. A
bare 66-hex chain pubkey recipient is taken as being on your network.

**Events:** `transfer:updated` (every status change), `transfer:attention` (needs operator
attention), `inventory:updated`, `history:updated`.

### `receive(): Promise<{ transfers: IncomingTransfer[] }>`

Explicit one-shot drain of the wallet-api mailbox. While the wallet runs, the mailbox is also
drained continuously (wake WebSocket + poll) — `receive()` exists for batch/CLI flows.

Every incoming token is **verified before entering the balance** (`engine.verify` against the
trust base + ownership check against this wallet's chain pubkey). Dedup is by **(tokenId,
stateHash)**: a token already held in that same state is acknowledged again, not stored twice; an
older, already-spent state of a held token is rejected; a token that comes back in a new state is
accepted again. Mailbox entries whose acknowledgement succeeded are remembered in a durable
seen-set (their mailbox entry ids, not token ids) and skipped on later drains. The token is stored
BEFORE the mailbox claim is acknowledged, so a crash re-claims instead of losing.

```typescript
const { transfers } = await sphere.payments.receive();
sphere.on('transfer:incoming', (t) => console.log('from', t.senderNametag));
// A coinless (NFT) arrival is named in `t.coinless`, never in `t.tokens` — read both.
```

### `assets(coinId?: string): Promise<Asset[]>`

Aggregated balances by coin (server read-through), with price data when a `PriceProvider` is
configured. The `Asset` shape is unchanged from pre-flip releases: `unconfirmedAmount` /
`unconfirmedTokenCount` are pinned `'0'` / `0` (nothing is ever unconfirmed in server custody);
`transferringAmount` / `transferringTokenCount` still report in-flight sends (excluded from
`totalAmount`).

```typescript
const assets = await sphere.payments.assets();
const uct = await sphere.payments.assets(coinIdHex);
const totalUsd = assets.reduce((s, a) => s + (a.fiatValueUsd ?? 0), 0);
```

### `tokens(filter?: { coinId?: string }): Token[]`

Synchronous inventory view. Lazy tokens (blob not yet downloaded) carry value metadata only;
the blob is fetched on demand when the token is selected for a spend.

```typescript
const all = sphere.payments.tokens();
const uctOnly = sphere.payments.tokens({ coinId: coinIdHex });
```

### `coinless(): CoinlessToken[]`

Synchronous view of holdings that name **no coin** — what a UI calls an NFT (wallet-api#140).

**Disjoint from `tokens()`**: an active token is in exactly one of the two reads, so existing
`tokens()`/`assets()` consumers are unaffected and a coinless token contributes to no balance.
It is deliberately not a `Token`: `Token` requires `coinId`, `symbol`, `decimals` and `amount`,
and filling those with `''`/`'0'` would put untrue values in fields consumers sum or format.

```typescript
interface CoinlessToken {
  readonly tokenId: string;      // genesis-stable INSTANCE key
  readonly tokenType?: string;   // the token's CLASS, lowercase hex — see below
  readonly name?: string;        // resolved from the OWNED registry, when recognised
  readonly iconUrl?: string;
  readonly stateHash: string;
  readonly transferring: boolean;   // reserved by a converging transfer
  readonly suspectedSpent?: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const nfts = sphere.payments.coinless();
```

`tokenType` names the token's **class, not the instance** — every token of one kind shares a type,
so two NFTs of a collection are told apart by `tokenId`. It is absent on rows the backend indexed
before it recorded types, and an unrecognised type is legitimate (a minter may use its own), so
never reject or hide a token for it. Do not build a "group by type" UI on it for *valued* tokens:
`mint()` and split outputs derive a type per operation, so there it is per-mint noise.

`name` and `iconUrl` are resolved **for you**, from the registry this wallet owns, whenever the type
is recognised. Do not look the type up yourself through `TokenRegistry.getInstance()`: a Sphere owns
its registry (#767) and the process-global one is repointed by another Sphere's init, so a second
wallet on another network would retarget it.

### `tokenData(tokenId: string): Promise<Uint8Array | null>`

The token's genesis payload — an NFT's actual content — or `null` when it carries none.

A call rather than a field on the row: the payload is unbounded and blobs are lazy under server
custody, so a list read must never carry it. Fetches the blob and decodes it. Throws
`VALIDATION_ERROR` for a token this wallet does not hold.

```typescript
const bytes = await sphere.payments.tokenData(nft.tokenId);
```

Note an **empty** payload reads back as a zero-length `Uint8Array`, not `null` — only a genuinely
absent one is `null`.

### `nft(tokenId: string): Promise<NftView | null>`

A held token's genesis payload read as an **NFT** under the NFT metadata standard (#785; the
normative format is [`docs/NFT-METADATA.md`](./NFT-METADATA.md)), or `null` when the payload is not
a recognised NFT — which includes every coin token.

```typescript
interface NftView {
  readonly tokenId: string;
  readonly content: NftContent;           // NftMetadata | NftMedia | NftLink — see NFT content types
  readonly creator: string | null;        // the key the payload CLAIMS (33-byte compressed, hex); null when unsigned
  readonly signature: NftSignatureStatus; // 'unsigned' | 'valid' | 'invalid'
}

const view = await sphere.payments.nft(row.tokenId);   // row from coinless()
if (view?.signature === 'valid') showCreator(view.creator);
```

- `signature` is checked against the token's network, **genesis** recipient, token id and token
  type, never its current owner, so a `valid` NFT stays `valid` across transfers.
- **`valid` is attribution, not authorization.** It shows which key signed this item for this token,
  not that the signer is a recognised artist or that a collection authorized the issue. Label it
  "Signed", not "Verified", and keep a recognised signer and collection membership as separate
  claims. Resolving `creator` to a @nametag is a separate lookup.
- **`creator` is only a claim until `signature === 'valid'`.** Anyone can mint a payload naming
  another wallet's key over a junk signature, so under `'invalid'` the field holds whatever key the
  minter wrote. Never show it, or resolve it to a @nametag, as the creator unless the status is `valid`.
- **Display-only.** `null` never means "refused": an unrecognised token is still held and
  transferable. Show its raw payload from `tokenData()`.
- Throws `VALIDATION_ERROR` for a token this wallet does not hold (checked before the cache and
  before any fetch), and `STORAGE_ERROR` when its blob is missing or decodes as another token — the
  `tokenData()` contract. A blob that fails to decode also throws.
- Readings are cached per wallet address (least-recently-used, 256 entries), a "not an NFT" answer
  included: a token id's genesis payload never changes. A failed decode is not cached.

### `nfts(tokenIds: readonly string[]): Promise<ReadonlyMap<string, NftView>>`

The batch read for list views: one batched blob read for every id not already cached (the wallet-api
port asks for at most 100 ids per request, under the server's per-request cap).

```typescript
const rows = sphere.payments.coinless();
const views = await sphere.payments.nfts(rows.map((r) => r.tokenId));
for (const row of rows) render(row, views.get(row.tokenId)); // undefined → show the raw payload
```

An id is simply **absent** from the map when this wallet does not hold it, its blob is missing or
does not decode, or its payload is not a recognised NFT. Duplicate ids are read once. Throws only
when the blob fetch itself fails or no token engine is available.

### NFT content types

```typescript
type NftContent = NftMetadata | NftMedia | NftLink;
type NftMediaRef = NftMedia | NftLink;
type NftSignatureStatus = 'unsigned' | 'valid' | 'invalid';

interface NftMetadata {                       // ERC-721 field names
  readonly kind: 'metadata';
  readonly name: string;                      // required
  readonly description: string | null;
  readonly image: NftMediaRef | null;         // never a document link
  readonly animation_url: NftMediaRef | null; // never a document link
  readonly external_url: string | null;
  readonly attributes: readonly NftAttribute[]; // [] when there are none, never null
  readonly collection: string | null;         // a display name only
  readonly collection_id: string | null;      // 1–64 bytes as even-length hex (read back lower case); a claim
}

interface NftAttribute {
  readonly trait_type: string;
  readonly value: string | number;            // text, or an integer within ±(2^53 − 1)
}

interface NftMedia {                          // an inline file
  readonly kind: 'media';
  readonly media_type: string;                // lowercase type/subtype, no parameters
  readonly bytes: Uint8Array;                 // non-empty
}

interface NftLink {                           // a hosted file, pinned by its hash
  readonly kind: 'link';
  readonly media_type: string;                // NFT_DOCUMENT_MEDIA_TYPE: the file is a metadata document
  readonly uri: string;                       // https://, ipfs:// or ar://; at most 2048 characters
  readonly sha256: string;                    // SHA-256 of the file's bytes, 64 hex (read back lower case)
}
```

Every text field is non-empty: an absent optional one is `null`, never `''`. Write decimals and
integers outside ±(2^53 − 1) as text. The complete rules are in
[`docs/NFT-METADATA.md`](./NFT-METADATA.md).

`collection_id` is an optional stable identifier of the collection the item claims, such as a
collection's token type identifier or the SHA-256 of a collection manifest; `collection` stays a
display name. Nothing verifies membership, so never present a `collection_id` as verified.

**Before rendering an `NftLink`**, fetch the file and check it: `verifyNftLinkContent(link, bytes)`
is `false` when the bytes' SHA-256 is not the pinned one, and then the file must not be rendered.
Render metadata text as plain text, never as markup.

**Document links.** An `NftLink` whose `media_type` is `NFT_DOCUMENT_MEDIA_TYPE`
(`'application/vnd.unicity.nft+cbor'`) points at a hosted metadata document, not at media;
`isNftDocumentLink(content)` tells the two apart. It is valid only as a token's content (top level
or signed), and `encodeNftContent` refuses one as `image` or `animation_url`. To resolve it, fetch
the file, check it with `verifyNftLinkContent(link, bytes)`, then read it with
`parseNftDocument(bytes)`: the `NftMetadata` or `NftMedia` item, or `null` for anything else. It
never throws.

The codec ships from the package root and the `./payments-v2` subpath: `encodeNftContent` (throws
`VALIDATION_ERROR` naming the offending field), `parseNftPayload` (never throws; `null` = not
recognised), `parseNftDocument`, `isNftDocumentLink`, `verifyNftLinkContent`,
`NFT_DOCUMENT_MEDIA_TYPE`, and the tag numbers `NFT_METADATA_TAG`, `NFT_MEDIA_TAG`, `NFT_LINK_TAG`,
`NFT_SIGNED_TAG` (`39052n`–`39055n`). The `./token-engine` subpath adds `encodeNftSigned`,
`nftSignedDigest(context, payload)`, `verifyNftSignature(signed, context)` and
`NFT_FORMAT_VERSION`, where `context` is an `NftSignatureContext`
(`{ networkId, recipientPredicate, tokenId, tokenType }`, as the token's mint records them).

### `sendWholeToken(req: { recipient, tokenId, memo? }): Promise<TransferResult>`

Move **one named token** whole — coinless or valued. All-or-nothing: one source, one direct
transfer, **never a split**, so a valued token's coins travel with it and no change comes back.

```typescript
const result = await sphere.payments.sendWholeToken({
  recipient: '@bob',
  tokenId: row.tokenId,     // from tokens() or coinless()
  memo: 'here you go',      // optional, recipient-encrypted
});
```

Distinct from `send()`, which **selects** sources to cover an amount and may split one. Use this when
the user picked a specific token and expects *that* token to move.

History records what actually moved: a valued token logs its real assets (every coin it carried), a
coinless one logs `assets: []`.

**Refused:** a token whose value envelope this SDK cannot decode (`bare_collection`, the bridged
dialect). Its coins are real but unaccountable here, so the move would happen while history could
only say `assets: []`. Also refused, before any chain op: a tokenId that is unknown, tombstoned,
already in flight, or #625-demoted.

A proven conflict is **terminal** — there is no alternative source to re-plan onto. Treat the
possibly-committed rules exactly as for `send()`: never re-issue after any error for which
`isPossiblyCommittedSendOutcome(err)` is `true`; `resumeNow()` converges it. One exception: a
`SEND_SYNC_PENDING` that carries no `err.transferId` (message `Cannot spend yet: …`) is a refusal
before anything was reserved or sent. The SDK spends nothing until it has confirmed which tokens
the transfers still converging hold; it runs that check when payments start (also after an
address switch) and on every convergence pass. Nothing moved and `pendingTransfers()` has no row
for it, so call `sendWholeToken` (or `sendCoinless`) again later. `resumeNow()` re-runs the check
but does not send the token.

### `sendCoinless(req: { recipient, tokenId, memo? }): Promise<TransferResult>`

The **NFT-scoped** twin of `sendWholeToken`: identical, except it refuses a source carrying coins.

Connect's `send_nft` intent must route here. Its `nft:transfer` scope deliberately does not authorise
coin transfers, so a dApp holding only that scope must not be able to move a valued token by naming
its id.

### `mint(coinId: string, amount: bigint): Promise<MintResult>`

Self-mint fungible tokens to this wallet via the token engine (no faucet). **Journal-first**:
the mint journal entry is durable before the chain op, and a replay converges by idempotent
same-seed re-call — crash-safe.

```typescript
const result = await sphere.payments.mint(coinIdHex, 1_000_000n);
// { success: true, tokenId } | { success: false, tokenId?, error }
```

- `coinId` must be even-length lowercase hex; `amount` must be `> 0n`.
  Otherwise it resolves `{ success: false, error }` with nothing journaled.
- **A failure after journaling keeps the entry.** A failed chain op resolves
  `{ success: false, error }`, and a failure after the mint certified resolves
  `{ success: false, tokenId, error }`; in both cases the facade replays that journal entry in its
  convergence pass (start, heartbeat, `resumeNow()`). **Do not call `mint()` again for a failed
  result**: a new call is a new, independent mint, so the amount can be minted twice.
- If the active address's token engine is unavailable when the call starts, `mint()` **rejects**
  (`AGGREGATOR_ERROR`) rather than resolving an error result.

### `mintNft(request: MintNftRequest): Promise<MintResult>`

Mint an NFT (#785) to this wallet. The content is encoded under the NFT metadata standard and, by
default, signed as its creator with this wallet's chain key.

```typescript
interface MintNftRequest {
  readonly content: NftContent;   // NftMetadata, NftMedia or NftLink — see NFT content types
  readonly sign?: boolean;        // default true: wrap in NftSigned, creator = this wallet's chain pubkey
}

const result = await sphere.payments.mintNft({
  content: {
    kind: 'metadata',
    name: 'Cool Cat #1',
    description: 'A ginger cat',
    image: { kind: 'media', media_type: 'image/png', bytes: pngBytes },
    animation_url: null,
    external_url: 'https://coolcats.example',
    attributes: [{ trait_type: 'Fur', value: 'Ginger' }, { trait_type: 'Lives', value: 9 }],
    collection: 'Cool Cats',
    collection_id: null,
  },
});
// { success: true, tokenId } | { success: false, tokenId?, error }
```

- The token always mints to this wallet, under the network's NFT vessel token type
  (`NETWORKS[network].nftTokenType`), and appears in `coinless()`. History records it as a `MINT`
  with `assets: []`; the `HistoryEntry` read back carries the `tokenId` and no coin (`coinId: ''`,
  `amount: '0'`).
- **Invalid content** returns `{ success: false, error }` naming the offending field. Nothing is
  journaled and nothing is minted.
- **Journal-first, like `mint()`.** The planned payload, salt and token type are journaled before
  the chain op. A failure after that returns `{ success: false, tokenId, error }` and keeps the
  entry, and the facade replays those SAME bytes in its convergence pass (start, heartbeat,
  `resumeNow()`) until the token is in inventory. **Never call `mintNft()` again for a failure that
  carries a `tokenId`**: a new call draws a new salt and mints a second NFT.
- A gateway failure during the mint is a journaled `{ success: false, tokenId, error }` (above).
  `mintNft()` rejects (`AGGREGATOR_ERROR`) only when the active address's token engine is
  unavailable as the call starts. A wallet whose oracle supplies no trust base or gateway URL never
  gets that far: `Sphere.init` already rejects with `INVALID_CONFIG`.
- **Size limit.** A genesis payload over `NFT_MAX_PAYLOAD_BYTES` (1 MiB, the 107-byte `NftSigned`
  wrapper included) returns `{ success: false, error }` with nothing journaled and nothing minted:
  wallet-api refuses a blob over its `MAX_BLOB_BYTES` only at upload, after the mint has certified.
  Inline media also travels with every transfer, growing the blob each time; prefer an `NftLink` for
  large files.

### `history(page?: { before?: string; limit?: number }): Promise<HistoryPage>`

Server read-through, paged, newest-first.

```typescript
interface HistoryEntry {
  id: string;
  type: 'SENT' | 'RECEIVED' | 'MINT';
  coinId: string;
  amount: string;
  symbol?: string;
  timestamp: number;
  memo?: string;
  transferId?: string;
  tokenId?: string;
  senderPubkey?: string;    senderNametag?: string;
  recipientPubkey?: string; recipientNametag?: string;
  tokenIds?: { id: string; amount: string }[];
}

interface HistoryPage {
  entries: HistoryEntry[];
  more: boolean;
  cursor: string | null;   // pass as `before` for the next page
}

const page = await sphere.payments.history({ limit: 50 });
const older = await sphere.payments.history({ before: page.cursor!, limit: 50 });
```

`TransactionHistoryEntry` (the root export) remains as an alias of the storage-level
`HistoryRecord` shape for UI code that types history rows.

### `pendingTransfers(): Promise<PendingTransfer[]>`

What is still converging, derived on each call from the vertical's journals (open intents,
deliveries still owed, and the shortfalls of partial sends), never a cached copy. Use it for a
"pending" list, for example after a possibly-committed `send()` rejection.

```typescript
interface PendingTransfer {
  transferId: string;
  kind: 'open' | 'shortfall';   // 'shortfall' = a partial send; `amount` is the remainder still owed
  recipient: string;
  coinId: string;
  amount: string;
  tokenId?: string;             // set instead of coinId/amount for a token-addressed spend
  legs: { certified: number; total: number }; // certified = journaled legs, delivery still owed
  deliveryPending: boolean;
  createdAt: number;
}
```

`PendingTransfer` is exported from `@unicitylabs/sphere-sdk/payments-v2`.

### `resumeNow(): Promise<void>`

Run a convergence pass now: resume open intents, then drain the delivery and mint journals. It
joins a pass that is already running. This is the **retry verb**: a "retry" button calls
`resumeNow()`, never `send()`, because a re-issued `send()` pays again. It does nothing before the
facade has started.

### `connectionStatus(): 'connected' | 'degraded' | 'offline'`

The wallet-api session status, readable at any time (a late-mounting indicator can seed itself
from it); the `connection:status` event is the change notification. `'offline'` before the facade
has started.

### `prewarmSend(request: SendRequest): Promise<void>` / `discardPrewarm(): void`

`prewarmSend` previews the coin selection for a send you are about to make and fetches those source
tokens' blobs ahead of time, so the send itself starts faster. It reserves nothing and does not
throw for a fetch failure or an amount it cannot cover; the send re-fetches whatever is missing or
has changed state since. `discardPrewarm` drops the warmed blobs.

### Payment Requests (`sphere.payments.requests`)

Requests ride the wallet-api rail; the memo travels in a recipient-ECDH encrypted envelope.

```typescript
interface PaymentsRequestsApi {
  create(to: string, terms: { coinId: string; amount: string; memo?: string }):
    Promise<{ success: boolean; requestId?: string; error?: string }>; // never throws
  list(): PaymentRequestView[];                // requests you RECEIVED
  pay(id: string): Promise<TransferResult>;   // durably 'settling' BEFORE any
                                              // possibly-committed throw (#441)
  decline(id: string): Promise<void>;         // server 403/409 propagate
  dismissProcessed(): void;                   // drop terminal entries from list()
}

interface PaymentRequestView {
  id: string;
  requestId: string;
  senderPubkey: string;
  senderNametag?: string;
  amount: string;        // base units (decimal string)
  coinId: string;        // the hex coin id
  symbol?: string;       // not set by the SDK
  message?: string;
  timestamp: number;
  status: 'pending' | 'settling' | 'paid' | 'rejected' | 'expired';
}
```

- `create()` never throws: it resolves `{ success, requestId?, error? }`, so check `success`. Its
  `coinId` is the hex id (see [`send()`](#sendreq-sendrequest-promisetransferresult)).
- `list()`, `payment_request:incoming` and `payment_request:updated` cover requests you
  **received**. The SDK does not track requests you created: detect that one was paid through
  `transfer:incoming` or `payments.history()`.
- Never pay from inside the `payment_request:incoming` handler without the user's decision;
  `pay()` and `decline()` are alternatives. `pay()` rethrows `send()`'s errors, so handle them as
  for `send()`.
- **Crash safety, exactly.** When the send inside `pay()` fails with a possibly-committed error,
  `pay()` links the request to that transfer in the payments journal and marks it `'settling'`
  before it rethrows, so the request is not payable, and the link survives a restart. One
  exception: if writing that link to storage fails, `pay()` rejects with the storage error instead
  of the send error, so `isPossiblyCommittedSendOutcome` is `false` for it although the payment may
  have gone out; the link is then held in memory and reaches storage only with a later successful
  journal write. A second `pay()` of the same id while the first is still running joins it. The
  link is written after the send returns or throws, not before it starts. If the app or process
  stops while `pay()` is still waiting on the send, or before a link that failed to write reaches
  storage, no link exists: on the next start the request is listed as `'pending'` again and
  `payment_request:incoming` fires again, even if the transfer went through (a transfer the SDK had
  already recorded is resumed when the wallet starts). Before paying a request again after a
  restart, check `sphere.payments.pendingTransfers()` and
  `sphere.payments.history()` for a transfer to that requester.

```typescript
import { TokenRegistry, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';
import type { PaymentRequestView } from '@unicitylabs/sphere-sdk/payments-v2';

// Requester side: create() never throws. It resolves { success, requestId?, error? }.
await TokenRegistry.waitForReady(); // the registry load that Sphere.init started
const coinId = getCoinIdBySymbol('UCT'); // the hex coin id, or undefined if unknown
if (coinId) {
  const created = await sphere.payments.requests.create('@bob', { coinId, amount: '1000000', memo: 'Invoice #42' });
  if (!created.success) console.error(created.error);
}

// Payer side: never pay from the event handler itself. Show the request and let the user decide.
sphere.on('payment_request:incoming', async (request: PaymentRequestView) => {
  // request.amount is a base-unit string and request.coinId the hex coin id; request.symbol is not set here.
  try {
    if (await askUser(request)) {
      await sphere.payments.requests.pay(request.id);
    } else {
      await sphere.payments.requests.decline(request.id);
    }
  } catch (err) {
    console.error('payment request failed', err); // pay() rethrows send() errors: handle them like send()
  }
});
```

---

## CommunicationsModule

### Methods

#### `sendDM(recipient: string, content: string): Promise<DirectMessage>`

Send a direct message using NIP-17 gift wrapping (kind 1059). The recipient can be a `@nametag` or a hex public key. When the sending address has a nametag, the content is wrapped in the Sphere messaging format (`{senderNametag, text}`) for compatibility with the Sphere app; an address without a nametag sends the content as-is.

```typescript
interface DirectMessage {
  readonly id: string;
  readonly senderPubkey: string;
  readonly senderNametag?: string;
  readonly recipientPubkey: string;
  readonly recipientNametag?: string;
  readonly content: string;
  readonly timestamp: number;
  isRead: boolean;
}
```

#### `getConversation(peerPubkey: string): DirectMessage[]`

#### `getConversations(): Map<string, DirectMessage[]>`

#### `markAsRead(messageIds: string[]): Promise<void>`

#### `getUnreadCount(peerPubkey?: string): number`

#### `broadcast(content: string, tags?: string[]): Promise<BroadcastMessage>`

#### `subscribeToBroadcasts(tags: string[]): () => void`

#### `getBroadcasts(limit?: number): BroadcastMessage[]`

#### `resolvePeerNametag(peerPubkey: string): Promise<string | undefined>`

Resolve a peer's nametag by their transport pubkey via live lookup from Nostr relay binding events. Returns `undefined` if the transport doesn't support resolution, the peer has no registered nametag, or the lookup fails. Useful as a fallback when no nametag is available in stored messages.

#### `onDirectMessage(handler: (msg: DirectMessage) => void): () => void`

Subscribe to incoming direct messages. Only NIP-17 gift-wrapped messages (kind 1059, the format the Sphere app sends) are delivered; legacy NIP-04 kind-4 events are ignored by the transport and never reach this handler. The sender's nametag is extracted from the Sphere messaging format if present.

**DM history on connect:** The SDK persists, per address, the timestamp of the last processed DM event. On reconnect, only DMs newer than that timestamp are fetched from the relay. On first connect (no persisted timestamp), the SDK starts from "now". The `dmSince` option of `Sphere.init()` (unix seconds) is meant as the fallback for that case, but in this release it does not reach the bundled Nostr transport's DM subscription: `Sphere.init` records it only after the wallet has been created or loaded, when the boot address's subscription is already set up, and for an address added later by `switchToAddress` the fallback is applied before the address is registered with the transport, so it is dropped. Do not rely on `dmSince` to fetch older DMs.

#### `onBroadcast(handler: (msg: BroadcastMessage) => void): () => void`

#### Other members

- `getConversationPage(peerPubkey: string, options?: GetConversationPageOptions): ConversationPage`
- `deleteConversation(peerPubkey: string): Promise<void>`
- `sendTypingIndicator(peerPubkey: string): Promise<void>`
- `sendComposingIndicator(recipientPubkeyOrNametag: string): Promise<void>`
- `onComposingIndicator(handler: (indicator: ComposingIndicator) => void): () => void` (the same
  indicator also reaches `sphere.on('composing:started', ...)`)

---

## GroupChatModule

NIP-29 relay-based group chat. Enable it with `Sphere.init({ ..., groupChat: true })` (the
network's default group relays, which is one reason `network` is required) or with a
`GroupChatModuleConfig`, then use `sphere.groupChat` (`GroupChatModule | null`: `null` unless
enabled). The snippets in this section use `groupChat` for that non-null module.

```typescript
const groupChat = sphere.groupChat; // GroupChatModule | null (null unless Sphere.init got groupChat)
if (groupChat) {
  const group = await groupChat.createGroup({ name: 'Traders' }); // GroupData | null
  if (group) {
    const msg = await groupChat.sendMessage(group.id, 'Hello'); // GroupMessageData | null
    await groupChat.sendMessage(group.id, 'Agreed', msg?.id); // third argument: replyToId?: string
    const recent = await groupChat.fetchMessages(group.id, undefined, 50); // (groupId, since?: ms, limit?)
  }
}
```

The standalone factory `createGroupChatModule(config?)` is exported from the package root (there
is no `@unicitylabs/sphere-sdk/modules/groupchat` subpath). A module built that way needs
`initialize({ identity, storage, emitEvent })` with a `FullIdentity`, private key included, which a
`Sphere` never hands out, so the factory is for building your own host, not for use next to a
`Sphere`.

### Group Management

#### `createGroup(options: CreateGroupOptions): Promise<GroupData | null>`

```typescript
interface CreateGroupOptions {
  name: string;
  description?: string;
  picture?: string;
  visibility?: GroupVisibility;    // 'PUBLIC' | 'PRIVATE' (default: PUBLIC)
  writeRestricted?: boolean;       // Only admins and moderators can post (default: false)
}

// Create a read-only announcement channel
const group = await groupChat.createGroup({
  name: 'Announcements',
  writeRestricted: true,
});
```

The new group's id (`GroupData.id`) is a slug of `name` followed by 16 random hex characters, for example `announcements-3f9a1c07b52e8d41`. A name with no Latin letters or digits gives `group-3f9a1c07b52e8d41`. Because of the random part, a group created with the same name as a deleted group gets a different id. Creating a group requires `crypto.getRandomValues`.

#### `fetchAvailableGroups(): Promise<GroupData[]>`

Fetches public groups from the relay. Returns `GroupData` objects including the `writeRestricted` flag.

#### `joinGroup(groupId: string, inviteCode?: string): Promise<boolean>`
#### `leaveGroup(groupId: string): Promise<boolean>`
#### `deleteGroup(groupId: string): Promise<boolean>`
#### `createInvite(groupId: string): Promise<string | null>`

### Messaging

#### `sendMessage(groupId: string, content: string, replyToId?: string): Promise<GroupMessageData | null>`

Returns `null` if the relay rejects the message (e.g., write-restricted group and user lacks permission).

#### `fetchMessages(groupId: string, since?: number, limit?: number): Promise<GroupMessageData[]>`

`since` is in **milliseconds** (the relay filter gets `Math.floor(since / 1000)`). To pass only a
limit, write `fetchMessages(groupId, undefined, 50)`: `fetchMessages(groupId, 50)` asks the relay
for everything since the epoch (50 ms rounds down to 0 s) and, because `since` is then set, without
the default message limit.

#### `getMessages(groupId: string): GroupMessageData[]`
#### `getMessagesPage(groupId: string, options?: GetGroupMessagesPageOptions): GroupMessagesPage`
#### `onMessage(handler: (message: GroupMessageData) => void): () => void`
#### `getTotalUnreadCount(): number`
#### `markGroupAsRead(groupId: string): void`
#### `deleteMessage(groupId: string, messageId: string): Promise<boolean>`

### Members & Permissions

#### `getMembers(groupId: string): GroupMemberData[]`
#### `getMember(groupId: string, pubkey: string): GroupMemberData | null`
#### `kickUser(groupId: string, userPubkey: string, reason?: string): Promise<boolean>`
#### `isCurrentUserRelayAdmin(): Promise<boolean>`
#### `isCurrentUserAdmin(groupId: string): boolean`
#### `isCurrentUserModerator(groupId: string): boolean`
#### `canModerateGroup(groupId: string): Promise<boolean>`

#### `canWriteToGroup(groupId: string): boolean`

Check if the current user can post messages to a group. For write-restricted groups, only admins and moderators can post. For normal groups, any member can write.

```typescript
if (!groupChat.canWriteToGroup(groupId)) {
  // Disable message input — group is read-only for this user
}
```

### Write-Restricted Groups

Groups with `writeRestricted: true` are read-only for regular members. Only users with admin or moderator roles can post messages. The relay enforces this server-side — rejected messages return `null` from `sendMessage()`.

```typescript
// Check via group metadata
const group = groupChat.getGroup(groupId);
if (group?.writeRestricted) {
  // Show read-only indicator in UI
}

// Check via convenience method (combines group flag + user role)
const canWrite = groupChat.canWriteToGroup(groupId);
```

### Queries

#### `getGroups(): GroupData[]`
#### `getGroup(groupId: string): GroupData | null`
#### `getCurrentUserRole(groupId: string): GroupRole | null`
#### `getConnectionStatus(): boolean`
#### `getRelayUrls(): string[]`
#### `getMyPublicKey(): string | null`

### GroupData

```typescript
interface GroupData {
  id: string;
  relayUrl: string;
  name: string;
  description?: string;
  picture?: string;
  visibility: 'PUBLIC' | 'PRIVATE';
  writeRestricted?: boolean;       // Only admins and moderators can post
  createdAt: number;
  updatedAt?: number;
  memberCount?: number;
  unreadCount?: number;
  lastMessageTime?: number;
  lastMessageText?: string;
  localJoinedAt?: number;          // When the current user joined this group locally
}
```

---

## MarketModule

The intent bulletin board: post and discover intents (`'buy' | 'sell' | 'service' |
'announcement' | 'other'`). Enable it with `Sphere.init({ ..., market: true })` (or a
`MarketModuleConfig` `{ apiUrl?, timeout? }`; the default API is `DEFAULT_MARKET_API_URL`,
`https://market-api.unicity.network`), then use `sphere.market` (`MarketModule | null`).
`postIntent`, `getMyIntents` and `closeIntent` send requests signed with the wallet's key; `search`
and `getRecentListings` are public reads.

#### `postIntent(intent: PostIntentRequest): Promise<PostIntentResult>`
#### `search(query: string, opts?: SearchOptions): Promise<SearchResult>`
#### `getMyIntents(): Promise<MarketIntent[]>`
#### `closeIntent(intentId: string): Promise<void>`
#### `getRecentListings(): Promise<FeedListing[]>`
#### `subscribeFeed(listener: FeedListener): () => void`

`subscribeFeed` opens a WebSocket to the live listing feed through the global `WebSocket`, reconnects
with backoff (up to 10 attempts), and returns a function that closes it.

---

## Errors

```typescript
class SphereError extends Error {
  readonly code: SphereErrorCode;   // e.g. 'INVALID_CONFIG', 'SEND_INSUFFICIENT_BALANCE', ...
  readonly cause?: unknown;
  transferId?: string;              // set only on possibly-committed send outcomes
}

class PartialSendConflictError extends SphereError {   // code 'SEND_PARTIALLY_COMPLETED'
  readonly transferId: string;                 // the first partial attempt's transferId
  readonly committedTokenIds: readonly string[]; // sources already certified and delivered: never re-send
  readonly remainingAmount: string;            // base units still owed; pay ONLY this, as a new send
}

function isSphereError(err: unknown): err is SphereError;
function isPossiblyCommittedSendOutcome(err: unknown): boolean;
```

All five are root exports (`SphereErrorCode` is the exported union of codes).
`isPossiblyCommittedSendOutcome(err)` is `true` for exactly `SEND_SYNC_PENDING`,
`CERTIFICATION_UNCONFIRMED`, `CHECKPOINT_PERSIST_FAILED`, `SPLIT_CHECKPOINT_LOST`,
`CHECKPOINT_TRUSTBASE_MISMATCH` and `SEND_PARTIALLY_COMPLETED`: the money may already have left
the wallet, so never re-send (see [`send()`](#sendreq-sendrequest-promisetransferresult)).
`PAYMENTS_NOT_COMPOSED` is the permanent refusal of `sphere.payments` on a `walletApi: 'none'`
wallet; `NOT_INITIALIZED` is the transient one.

`ALREADY_INITIALIZED` refuses to write a wallet over one that is already there, and nothing is
erased when it is thrown: `Sphere.create()` always, and `Sphere.import()` /
`Sphere.importFromLegacyFile()` unless `overwrite: true` is passed (`importFromJSON()`, and
`importFromLegacyFile()` for an `exportToJSON()` file, return its message as
`{ success: false, error }` instead). `registerNametag()` throws it too, when the active address
already has a Unicity ID.

**One class per bundle.** Each built entry point that uses `SphereError` (the package root,
`./core`, `./payments-v2`, `./token-engine`, `./impl/nodejs`, `./impl/browser`,
`./impl/wallet-api-v2` and `./connect`) carries its own copy of it, and `isSphereError()` is an
`instanceof` check. So an error thrown by provider code (for example the Nostr transport during a
recipient lookup) is not `instanceof` the root `SphereError`, and `isSphereError()` is `false` for
it: read `code` structurally (`(err as { code?: unknown }).code`). Import
`isPossiblyCommittedSendOutcome` and `PartialSendConflictError` from the same entry point as
`Sphere`, so they recognise the errors that entry's payments code throws.

---

## Types

### Identity and FullIdentity

**Single Identity Model**: the same secp256k1 key pair powers all wallet operations. The same `privateKey`/`chainPubkey` is used for:
- L3 token ownership and transfers (via `chainPubkey` and `directAddress`)
- Nostr P2P messaging (derived transport key)

`sphere.identity` is an `Identity` (public fields only). `FullIdentity` adds the private key; it
is what the SDK's modules receive internally, and a `Sphere` never returns one.

```typescript
interface Identity {
  /** 33-byte compressed secp256k1 public key (for L3 chain) */
  readonly chainPubkey: string;
  /** L3 DIRECT address (DIRECT://...) */
  readonly directAddress?: string;
  /** Legacy derived id: '12D3KooW' + first 40 hex chars of sha256(chainPubkey bytes); nothing in the SDK uses it */
  readonly ipnsName?: string;
  /** Registered @name alias */
  readonly nametag?: string;
}

interface FullIdentity extends Identity {
  readonly privateKey: string;        // secp256k1 private key (hex)
}
```

### AddressInfo

```typescript
interface AddressInfo {
  privateKey: string;   // secp256k1 private key (hex)
  publicKey: string;    // 33-byte compressed public key (hex)
  path: string;         // Full BIP32 path
  index: number;        // Address index
}
```

Note: `AddressInfo.publicKey` is the same format as `Identity.chainPubkey` (33-byte compressed secp256k1).
There is no address field: `AddressInfo` is key material (never log or serialise it), and the
`DIRECT://` address of an index is `sphere.getTrackedAddress(index)?.directAddress` once the index is
tracked.

### TrackedAddressEntry

Minimal data stored in persistent storage for a tracked address.

```typescript
interface TrackedAddressEntry {
  readonly index: number;      // HD derivation index — must be a uint32 (see below)
  hidden: boolean;             // Whether hidden from UI
  readonly createdAt: number;  // Timestamp (ms) when first activated
  updatedAt: number;           // Timestamp (ms) of last modification
}
```

`index` is a **BIP32 child number, so it must be a uint32**: an integer in `0` … `0xffffffff`.
It is enforced at both ends. A **write** carrying such a row — `saveTrackedAddresses`, and every
address-index API that derives keys (`switchToAddress`, `deriveAddress`, `trackScannedAddresses`,
`discoverAddresses`) — is **refused** with a typed `SphereError`; a row already **stored** is
**dropped when the registry is read**, not repaired, so one bad row cannot brick later writes.
Neither is repaired because `1.5` would `parseInt()` down to index 1's derivation path and hand
back that address's keys, and anything above `0xffffffff` pads to more than 8 hex digits and
derives off-standard.

`createdAt` / `updatedAt` are repaired instead: a missing or non-finite value reads as `0`, and
`hidden` reads as `true` only for an exact `true`.

Custom `StorageProvider` implementations own this: see
[the tracked-address write contract](./INTEGRATION.md#the-tracked-address-write-contract) for
the merge rules `saveTrackedAddresses` must obey.

### TrackedAddress

Full tracked address with derived fields (available in memory via `getActiveAddresses()`, etc.).

```typescript
interface TrackedAddress extends TrackedAddressEntry {
  readonly addressId: string;      // Short ID (e.g., "DIRECT_abc123_xyz789")
  readonly directAddress: string;  // L3 DIRECT address (DIRECT://...)
  readonly chainPubkey: string;    // 33-byte compressed secp256k1
  readonly nametag?: string;       // Primary nametag (without @ prefix)
}
```

### ProviderStatus

```typescript
type ProviderStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
```

### SphereEventType

```typescript
type SphereEventType =
  // The 8 payments-vertical events
  | 'transfer:incoming'
  | 'transfer:updated'
  | 'transfer:attention'
  | 'inventory:updated'
  | 'history:updated'
  | 'payment_request:incoming'
  | 'payment_request:updated'
  | 'connection:status'
  // Messaging
  | 'message:dm'
  | 'message:read'
  | 'message:typing'
  | 'composing:started'
  | 'message:broadcast'
  // Lifecycle / identity
  | 'connection:changed'
  | 'nametag:registered'
  | 'nametag:recovered'
  | 'identity:changed'
  | 'address:activated'
  | 'address:hidden'
  | 'address:unhidden'
  // Group chat
  | 'groupchat:message'
  | 'groupchat:joined'
  | 'groupchat:left'
  | 'groupchat:kicked'
  | 'groupchat:group_deleted'
  | 'groupchat:updated'
  | 'groupchat:connection'
  | 'groupchat:ready'
  | 'communications:ready';
```

Handlers receive the payload itself (`sphere.on('identity:changed', (e) => e.addressIndex)`), not
a wrapper with `.data`. Relay events (`transport:relay_added`, `transport:relay_removed`, …) are not
Sphere events: the Nostr transport provider emits them on its own `onEvent()` bus, and its
connect/disconnect changes also reach `sphere.on('connection:changed', ...)`. Nametag recovery during
`Sphere.init` / `load` / `import` finishes, and emits `nametag:recovered`, before the call returns,
so a listener added afterwards does not see it: read `sphere.identity?.nametag` after init.

The pre-flip names (`transfer:confirmed`, `transfer:failed`, `payment_request:paid`, `sync:*`,
`invoice:*`, `swap:*`, `walletapi:session`, …) are gone from the public event map. dApps on the
Connect wire still receive the old names via the ConnectHost compat adapter (see
`docs/CONNECT.md`), but direct `sphere.on()` consumers use the v2 names.

### SphereEventMap

```typescript
interface SphereEventMap {
  'transfer:incoming': IncomingTransfer;
  'transfer:updated': TransferResult;                 // read status / deliveryPending
  'transfer:attention': { transferId: string; code: string; detail?: string };
  'inventory:updated': Record<string, never>;
  'history:updated': HistoryEntry;                    // the just-recorded entry
  'payment_request:incoming': PaymentRequestView;
  'payment_request:updated': { id: string; status: 'pending' | 'settling' | 'paid' | 'rejected' | 'expired' };
  'connection:status': { status: 'connected' | 'degraded' | 'offline' };
  'message:dm': DirectMessage;
  'message:read': { messageIds: string[]; peerPubkey: string };
  'message:typing': { senderPubkey: string; senderNametag?: string; timestamp: number };
  'composing:started': ComposingIndicator;            // { senderPubkey; senderNametag?; expiresIn }
  'message:broadcast': BroadcastMessage;
  'connection:changed': { provider: string; connected: boolean; status?: ProviderStatus; enabled?: boolean; error?: string };
  'nametag:registered': { nametag: string; addressIndex: number };
  'nametag:recovered': { nametag: string };
  'identity:changed': {
    directAddress?: string;
    chainPubkey: string;
    nametag?: string;
    addressIndex: number;
  };
  'address:activated': { address: TrackedAddress };
  'address:hidden': { index: number; addressId: string };
  'address:unhidden': { index: number; addressId: string };
  'groupchat:message': GroupMessageData;
  'groupchat:joined': { groupId: string; groupName: string };
  'groupchat:left': { groupId: string };
  'groupchat:kicked': { groupId: string; groupName: string };
  'groupchat:group_deleted': { groupId: string; groupName: string };
  'groupchat:updated': Record<string, never>;
  'groupchat:connection': { connected: boolean };
  'groupchat:ready': { groupCount: number };
  'communications:ready': { conversationCount: number };
}
```

---

## Unicity ID (Nametag) Registration

Nametags (Unicity IDs, `@alice`) are **Nostr identity bindings** (name ↔ chainPubkey) — there is no PROXY address scheme and receive is always locked to the recipient's chain pubkey (`SignaturePredicate`). Registration publishes the binding; ownership follows UNIP-01 (marked bindings, single owner by relay receive order, ambiguous → null; `created_at` first-seen-wins only for legacy unmarked bindings), see [NAMETAG-BINDINGS.md](./NAMETAG-BINDINGS.md#anti-hijacking).

### Sphere Methods

```typescript
// Register the nametag for the current active address.
// Publishes the Nostr identity binding; throws SphereError('VALIDATION_ERROR')
// when the name is invalid or already taken.
await sphere.registerNametag('alice');

// Check if a nametag is available (no binding resolves for it)
const available = await sphere.isNametagAvailable('alice');
```

### Storage

Registration is **Nostr-binding-only**. The self-issued `UnicityIdToken` on-chain claim was
removed back at the 2.0.0 state-transition-sdk bump (upstream deleted the unicity-id primitive);
`NametagData` relics from older versions are no longer readable — the Nostr binding is the
registration, and it is recovered from Nostr on wallet import.

---

## Provider Setup

### Base Providers (Platform-Specific)

Create a base provider bundle with storage, transport, and oracle. These are platform-specific:
`@unicitylabs/sphere-sdk/impl/nodejs` and `@unicitylabs/sphere-sdk/impl/browser`. Neither bundle
carries `network`, so `Sphere.init` must be given it too: use the same literal in all three places
(base providers, `walletApi`, `Sphere.init`).

**Node.js variant.** Install `ws` next to the SDK (`npm install @unicitylabs/sphere-sdk ws`).
`@unicitylabs/sphere-sdk/impl/nodejs` imports `ws` when the module loads, on every Node version, and
the package declares `ws` only as an optional peer dependency, so npm does not install it for you.
The package's `engines` field requires Node.js 22 or later.

```typescript
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const base = createNodeProviders({
  network: 'testnet2',                // Required
  dataDir: './wallet-data',           // Optional (default './sphere-data')
  oracle: {
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590', // Public testnet2 key (NOT a secret)
  },
});
```

`@unicitylabs/sphere-sdk/impl/nodejs` also exports `createWalletApiProviders`, with types.

**Several wallets in one `dataDir`.** Each wallet lives in one file — `walletFileName` (default
`'wallet.json'`) under `dataDir` — so a second wallet goes under its own file name rather than over
the current one (`Sphere.import` refuses a storage that already holds a wallet unless
`overwrite: true`). `listWallets(dataDir: string): Promise<NodeWalletFile[]>`, also exported by
`@unicitylabs/sphere-sdk/impl/nodejs`, lists them: the `.json` and `.txt` files directly in that
directory that hold a stored seed, sorted by `fileName`, each one
`{ fileName: string; filePath: string; passwordProtected: boolean }`. Pass `fileName` back as
`walletFileName` to open that wallet; `filePath` is absolute; `passwordProtected` is `true` when
`Sphere.load()` needs the wallet's `password` to read the seed; `listWallets` itself never needs
one — it only repeats `Sphere.load()`'s password-less read. It skips `exportToJSON()` backup files,
and returns `[]` for a directory that does not exist.

**Browser variant:**
```typescript
import { createBrowserProviders } from '@unicitylabs/sphere-sdk/impl/browser'; // untyped entry: add the declaration shim below

const base = createBrowserProviders({
  network: 'testnet2',
  oracle: {
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590',
  },
});
```

`@unicitylabs/sphere-sdk/impl/browser` ships no type declarations in this release; under `strict`
TypeScript add the declaration shim below (or a one-line
`declare module '@unicitylabs/sphere-sdk/impl/browser';`, which types everything from that entry as
`any`). Import `createWalletApiProviders` from the typed
`@unicitylabs/sphere-sdk/impl/shared/wallet-api` subpath, not from `./impl/browser`.

```typescript
// Consumer-side declarations for '@unicitylabs/sphere-sdk/impl/browser'.
// That entry ships no .d.ts (tsup builds it with dts: false), so strict
// TypeScript reports TS7016 on the import without this file. Delete it once
// the package ships declarations for ./impl/browser.
declare module '@unicitylabs/sphere-sdk/impl/browser' {
  import type {
    NetworkType, StorageProvider, TransportProvider, OracleProvider, PriceProvider,
    PricePlatform, GroupChatModuleConfig, MarketModuleConfig,
  } from '@unicitylabs/sphere-sdk';

  export interface BrowserProvidersConfig {
    /** Required: createBrowserProviders throws INVALID_CONFIG without it. */
    network: NetworkType;
    debug?: boolean;
    storage?: { prefix?: string; dbName?: string; debug?: boolean };
    transport?: {
      relays?: string[]; additionalRelays?: string[]; timeout?: number; autoReconnect?: boolean;
      debug?: boolean; reconnectDelay?: number; maxReconnectAttempts?: number;
    };
    oracle?: { url?: string; apiKey?: string; timeout?: number; skipVerification?: boolean; debug?: boolean };
    price?: { platform?: PricePlatform; apiKey?: string; baseUrl?: string; cacheTtlMs?: number; timeout?: number; debug?: boolean };
    groupChat?: { enabled?: boolean; relays?: string[] } | boolean;
    market?: { apiUrl?: string; timeout?: number } | boolean;
  }

  export interface BrowserProviders {
    storage: StorageProvider;
    transport: TransportProvider;
    oracle: OracleProvider;
    price?: PriceProvider;
    groupChat?: GroupChatModuleConfig | boolean;
    market?: MarketModuleConfig | boolean;
  }

  export function createBrowserProviders(config: BrowserProvidersConfig): BrowserProviders;
}
```

### Wallet-API Transport Config (REQUIRED for money)

`createWalletApiProviders` attaches the plain transport config (`walletApi`) the payments
vertical is composed from. Without it (or the explicit `walletApi: 'none'`, below), `Sphere.init`
throws `INVALID_CONFIG`.

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/shared/wallet-api';

const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',  // testnet2 wallet-api
  network: 'testnet2',
  deviceId,                                       // stable on this device, different on every device
});
// providers = { ...base, walletApi: { network, baseUrl, deviceId } }

const { sphere } = await Sphere.init({ ...providers, network: 'testnet2', autoGenerate: true });
```

`Sphere.init` compares its own `network` with `walletApi.network` as plain strings and throws
`INVALID_CONFIG` ("walletApi.network "testnet2" does not match the Sphere network ...") when they
differ, including when `Sphere.init` gets no `network` at all. `'testnet'` and `'testnet2'` reach
the same endpoints but are different strings, so mixing them fails this check. The wallet-api
deployment names its network too: the testnet2 deployment signs you in only as `'testnet2'`, and
the SDK refuses a sign-in challenge for any other network. Use `'testnet2'` everywhere.

`deviceId` names this device's wallet-api session (the refresh-token row). Keep it stable across
launches on one device and different on every device, for example a UUID you persist locally; two
devices that share one id overwrite each other's session. Without it the SDK uses a fresh
`sphere-<uuid>` on every run, which means a fresh challenge sign-in each time.

Advanced fields on the config: `fetchFn` (injectable fetch; default `globalThis.fetch`),
`webSocketFactory` (default `globalThis.WebSocket`; inject one where there is no global
`WebSocket`), and `paymentsV2Transport(args)` — a DI seam that replaces the whole per-address
transport bundle (`{ session, client }`) for tests or custom hosts; when supplied, the `walletApi`
config's `baseUrl` is not required, and the seam wins over it. `createWalletApiProviders()` still
types `baseUrl` as required, so to supply the transport yourself, build the config directly:

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import type { WalletApiTransportConfig } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

// createWalletApiProviders() types baseUrl as required. To supply the transport yourself,
// build the walletApi config directly: there baseUrl is optional when paymentsV2Transport is set.
const base = createNodeProviders({ network: 'testnet2' });
const walletApi: WalletApiTransportConfig = { network: 'testnet2', paymentsV2Transport };
const { sphere } = await Sphere.init({ ...base, walletApi, network: 'testnet2', autoGenerate: true });
```

### Messaging-only wallet (`walletApi: 'none'`)

A wallet that only messages (DMs, group chat, nametags) passes `walletApi: 'none'`. It composes no
money: no wallet-api session, no token engine, no payments state. `network` is still required,
because it selects the token registry and the group-chat relays. `sphere.hasPayments` is then
`false`, and `sphere.payments` throws `PAYMENTS_NOT_COMPOSED`. Leaving `walletApi` out altogether
still throws `INVALID_CONFIG`.

```typescript
import { Sphere } from '@unicitylabs/sphere-sdk';
import { createNodeProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const base = createNodeProviders({ network: 'testnet2' });

const { sphere } = await Sphere.init({
  ...base,
  walletApi: 'none',   // messaging only: no wallet-api session, no token engine, no money
  network: 'testnet2', // still required: it selects the token registry and group-chat relays
  autoGenerate: true,
});

sphere.hasPayments; // false; reading sphere.payments throws PAYMENTS_NOT_COMPOSED
await sphere.communications.sendDM('@alice', 'hello');
```

### Full Initialization Example (Node.js)

```typescript
// npm install @unicitylabs/sphere-sdk ws
import { Sphere, TokenRegistry, getCoinIdBySymbol } from '@unicitylabs/sphere-sdk';
import { createNodeProviders, createWalletApiProviders } from '@unicitylabs/sphere-sdk/impl/nodejs';

const NETWORK = 'testnet2'; // one literal for all three places

// 1. Create base providers (storage, transport, oracle)
const base = createNodeProviders({
  network: NETWORK,
  dataDir: './wallet-data', // optional, default './sphere-data'
  oracle: {
    apiKey: 'sk_ddc3cfcc001e4a28ac3fad7407f99590', // Public testnet2 key
  },
});

// 2. Attach the wallet-api transport config (required for money)
const providers = createWalletApiProviders(base, {
  baseUrl: 'https://wallet-api.unicity.network',
  network: NETWORK,
  deviceId: 'my-service-host-1', // stable on this machine, unique per machine
});

// 3. Initialize the wallet (network again: the provider bundles do not carry it)
const { sphere, created, generatedMnemonic } = await Sphere.init({
  ...providers,
  network: NETWORK,
  autoGenerate: true,
  password: 'my-password', // Optional: encrypt mnemonic
});

// 4. Send a token (coinId is the 64-hex coin id)
await TokenRegistry.waitForReady();
const coinId = getCoinIdBySymbol('UCT');
if (!coinId) throw new Error('UCT is not in this network\'s token registry');
const result = await sphere.payments.send({
  recipient: '@alice',
  amount: '1000000',
  coinId,
  memo: 'hi',
});
console.log(result.status);          // 'delivered', or 'confirmed' while delivery is pending
console.log(result.deliveryPending); // true if deferred, false if landed

// 5. Receive transfers (explicit mailbox drain)
const { transfers } = await sphere.payments.receive();
console.log('received', transfers.length, 'transfers');

// 6. Shut down so the process can exit
await sphere.destroy();
TokenRegistry.destroy(); // stops the process-global registry refresh timer
```

`sphere.destroy()` stops this Sphere's own registry, but `Sphere.init` also configures the
process-wide `TokenRegistry`, whose hourly refresh timer keeps Node's event loop alive. Call
`TokenRegistry.destroy()` after `sphere.destroy()` when the process should exit.

---

## OracleProvider (Network-Config Provider)

The oracle is a **thin network-config provider** for the token engine: it loads the root trust base (JSON) and exposes the gateway URL + API key. The engine (`token-engine/`) builds its own SDK clients from these — no state-transition SDK objects cross this boundary.

```typescript
interface OracleProvider extends BaseProvider {
  /**
   * Initialize the provider. Loads the trust base JSON via the configured
   * platform loader when none is passed explicitly.
   */
  initialize(trustBaseJson?: unknown): Promise<void>;

  /** Raw trust-base JSON (the engine parses it; the networkId comes from it). */
  getTrustBaseJson(): unknown | null;

  /** Gateway (aggregator) base URL. */
  getAggregatorUrl(): string;

  /** Gateway API key, when the gateway requires one (e.g. testnet2). */
  getApiKey(): string | undefined;

  /** Optional: swap the gateway key on a live provider (pair with Sphere.setOracleApiKey). */
  setApiKey?(apiKey: string): void;
}
```

Network configuration:

| | testnet2 | mainnet |
|---|---|---|
| `network` literal (all three places) | `'testnet2'` | `'mainnet'` |
| networkId (from the trust base) | `4` | `1` |
| Gateway (`NETWORKS[n].aggregatorUrl`) | `https://gateway.testnet2.unicity.network` | `https://gateway.mainnet.unicity.network` |
| Gateway API key | public: `sk_ddc3cfcc001e4a28ac3fad7407f99590` | a secret; keep it in your deploy environment |
| wallet-api `baseUrl` | `https://wallet-api.unicity.network` | `https://wallet-api.mainnet.unicity.network` |
| Nostr relay | `wss://nostr-relay.testnet.unicity.network` | the same relay (mainnet has none of its own yet) |
| Token registry fungible coins | UCT, USDU, EURU, SOL, BTC, ETH, … | none yet (only the NFT token type) |

Both mainnet and testnet2 are live, each with its own gateway and wallet-api deployment. On
mainnet use `network: 'mainnet'` in `createBrowserProviders`/`createNodeProviders`, in the
`walletApi` config and on `Sphere.init`, the mainnet wallet-api
`https://wallet-api.mainnet.unicity.network`, and your mainnet gateway API key, which is a secret.
Mainnet shares testnet2's Nostr relay for now, and its token registry lists no fungible coins yet.
`'testnet'` is a second key with testnet2's endpoints; do not mix it with `'testnet2'` (see
[`network`](#sphereinitoptions-sphereinitoptions-promisesphereinitresult)). There is no `dev`
network: that preset was removed with the v1 network.

---

## TokenRegistry

Token metadata (symbol, name, decimals, icons) by coin ID — fetched from the network's registry
URL, cached in the `StorageProvider`, refreshed hourly. The lookup methods
(`getDefinition`, `getSymbol`, `getDecimals`, `getCoinIdBySymbol`, `getAllDefinitions`, …) are
covered in the [Browser](./QUICKSTART-BROWSER.md#look-up-asset-metadata) and
[Node.js](./QUICKSTART-NODEJS.md#look-up-asset-metadata) quick starts. This section is the
**lifecycle** surface.

### Two kinds of registry

| | Process-global singleton | Owned instance |
|---|---|---|
| Obtain | `TokenRegistry.getInstance()`, configured by `TokenRegistry.configure(options)` | `TokenRegistry.create(options)` |
| Who else can repoint it | **anyone** — `configure()` reaches into whatever instance exists, and every `Sphere.init()` calls it | nobody |
| Stopping it | `TokenRegistry.resetInstance()` / `TokenRegistry.destroy()` | `registry.dispose()` |

A `Sphere` **builds and owns its own registry** (`TokenRegistry.create`) and the payments facade
presents from that one, so two Spheres on different networks can no longer overwrite each
other's metadata. `sphere.destroy()` disposes it. The global is still configured by
`Sphere.init()` for code that reads it directly (`getCoinIdBySymbol()` and the other root lookup
functions read it), and it is deliberately left running; in Node, call `TokenRegistry.destroy()`
after `sphere.destroy()` when the process should exit.

`TokenRegistry.configure()` and `TokenRegistry.create()` take the same options. The
`TokenRegistryConfig` type is not exported from the package root; name it as
`Parameters<typeof TokenRegistry.create>[0]` if you need it:

```typescript
interface TokenRegistryConfig {
  remoteUrl?: string;          // registry JSON URL — NETWORKS[network].tokenRegistryUrl
  storage?: StorageProvider;   // persistent cache
  refreshIntervalMs?: number;  // default 1 hour
  autoRefresh?: boolean;       // default true
}
```

### `TokenRegistry.create(options: TokenRegistryConfig): TokenRegistry`

Build an **independent** registry rather than touching the singleton. The options are applied
immediately — a cache read first, then the remote fetch, which is awaited only when the cache
misses — exactly as `configure()` does on the global. Dispose it when its owner goes away.

```typescript
import { TokenRegistry, NETWORKS } from '@unicitylabs/sphere-sdk';

const registry = TokenRegistry.create({
  remoteUrl: NETWORKS.testnet2.tokenRegistryUrl,
  storage: providers.storage,
});

await registry.waitForReady();
const uct = registry.getDefinitionBySymbol('UCT');

registry.dispose();
```

### `registry.dispose(): void`

Stop this registry for good: no refresh timer, no late apply of an in-flight fetch, no late
cache write — the request already in the air is aborted, not merely ignored. Idempotent.

Required for any registry you `create()`: nothing in `registry/` calls `unref()`, so an
undisposed registry keeps an hourly fetch running and, under Node, keeps the event loop alive.

Reads still work after disposal; they are simply **frozen** at the last-applied definitions.
Disposal is permanent — a disposed registry cannot be revived, so build a new one with
`create()`.

### `registry.isDisposed: boolean`

Whether `dispose()` has been called.

### `registry.waitForReady(timeoutMs?: number): Promise<boolean>`

Wait for the initial load (cache, else remote) to settle. Resolves `true` when definitions were
loaded, `false` on timeout or when there was no data source. `timeoutMs` defaults to `10_000`;
pass `0` to wait without a timeout. The static `TokenRegistry.waitForReady()` is the same
contract against the singleton.

