/**
 * Sphere.init vault + courier round-trip vs the REAL in-process token-api
 * (Deliverable 1). Where `vault.e2e.test.ts` drives the storage/courier providers
 * DIRECTLY, this test proves the FULL wiring lands when you flip the two
 * `Sphere.init` flags — the SDK builds the vault provider + courier transport
 * internally (the app never holds the spend key) and threads them into the
 * PaymentsModule money path. The token-api is the SAME real server the other e2e
 * boots (mongodb-memory-server replica set, real fetch HTTP clients, byte-for-byte
 * the `/v1/vault/*` + `/v1/courier/*` wire).
 *
 * WHAT IS REAL vs SEAMED
 *  - REAL: the token-api (vault CAS + courier store-and-forward + JWT auth), all
 *    HTTP over real fetch; the WHOLE Sphere.init create/load path; the
 *    PaymentsModule send/receive/sync/GC logic; the vault reserved-address
 *    (XP-invariant DIRECT) round-trip.
 *  - SEAMED (the smallest faithful seam): the L3 *token engine*. A live engine needs
 *    the testnet2 gateway + a funded wallet, which an in-process e2e cannot stand up
 *    deterministically. So `createSphereTokenEngine` is mocked to return the
 *    repo's `FakeTokenEngine` — but KEYED to the real per-wallet spend key the SDK
 *    passes it (so each wallet's engine owns/derives exactly its own identity), and
 *    the engine still flows through Sphere's real `buildTokenEngine` → PaymentsModule
 *    wiring untouched. The fake produces real CBOR(TokenBlob)s that the courier
 *    carries and the recipient's engine decodes/verifies — the delivery + storage
 *    path is genuine end-to-end.
 *
 * ASSERTED ROUND-TRIPS
 *  1. VAULT backup + reload: wallet A mints a token, `sphere.payments.sync()` flushes
 *     encrypted entries to the vault (the registered RemoteTokenStorageProvider).
 *     A FRESH `Sphere.load` of the SAME identity (cold local token store) restores
 *     the token FROM the vault and restores `_meta.address` to the XP-invariant
 *     DIRECT address (the vault's reserved-address slot).
 *  2. COURIER A→B: A `send()`s to B's chainPubkey; the finished blob is DEPOSITED
 *     over the courier (token-api inbox count rises). B `receive()` pulls it, the
 *     bound `handleV2Transfer` verifies + stores it (B's balance reflects it) and
 *     B acks. A's `pollSent` sees the valid ack and GCs `PENDING_V2_DELIVERIES`.
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- test seams reach private deps */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The ONLY seam: substitute the live L3 engine with the repo FakeTokenEngine, keyed
// to the real spend key the SDK passes in. Everything else in token-engine (the
// DIRECT-address derivation, the unicity-id minter, the port types) stays REAL via
// importActual, so Sphere's identity + wiring run unchanged. Hoisted before the
// Sphere import so the mock is in place when core/Sphere.ts binds the symbol.
vi.mock('../../token-engine', async (importActual) => {
  const actual = await importActual<typeof import('../../token-engine')>();
  const { FakeTokenEngine } = await import('../unit/token-engine/FakeTokenEngine');
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  return {
    ...actual,
    // Sphere calls this from buildTokenEngine with the wallet's real privateKey;
    // derive the compressed pubkey so the fake engine OWNS this wallet's identity
    // (mint targets it, isOwnedBy(self) holds, transfers to a peer pubkey decode on
    // the peer's engine). network 2 is shared by both wallets so blobs interop.
    createSphereTokenEngine: (config: { privateKey: Uint8Array }) => {
      const chainPubkey = secp256k1.getPublicKey(config.privateKey, true);
      return Promise.resolve(new FakeTokenEngine({ chainPubkey, network: 2 }));
    },
  };
});

import { Sphere } from '../../core/Sphere';
import { TokenRegistry } from '../../registry';
import { deriveDirectAddress } from '../../token-engine/identity';
import { bootTokenApi, type BootedTokenApi } from './support/token-api-boot';
import { STORAGE_KEYS_ADDRESS, STORAGE_KEYS_GLOBAL } from '../../constants';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../storage';
import type { TransportProvider, PeerInfo } from '../../transport';
import type { OracleProvider } from '../../oracle';
import type { FullIdentity } from '../../types';

// Mock L1 so init never reaches Fulcrum (mirrors the Sphere core tests).
vi.mock('../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

const NETWORK = 'testnet2';
/** Even-length lowercase hex coin id (the canonical v2 AssetId form the engine requires). */
const COIN = '11'.repeat(32);

/**
 * Two well-known BIP39 mnemonics → two deterministic wallets. (The classic
 * abandon×11+about vector for A, and ×11+art for B.)
 */
const MNEMONIC_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const MNEMONIC_B =
  'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong';

/** A simple in-memory StorageProvider whose backing map the test can inspect/seed. */
function makeStorage(): StorageProvider & { _data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    id: 'mem-storage',
    name: 'Mem Storage',
    type: 'local' as const,
    setIdentity: vi.fn(),
    get: vi.fn((k: string) => Promise.resolve(data.get(k) ?? null)),
    set: vi.fn((k: string, v: string) => { data.set(k, v); return Promise.resolve(); }),
    remove: vi.fn((k: string) => { data.delete(k); return Promise.resolve(); }),
    has: vi.fn((k: string) => Promise.resolve(data.has(k))),
    keys: vi.fn(() => Promise.resolve([...data.keys()])),
    clear: vi.fn(() => { data.clear(); return Promise.resolve(); }),
    connect: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(() => Promise.resolve()),
    isConnected: vi.fn(() => true),
    getStatus: vi.fn(() => 'connected' as const),
    saveTrackedAddresses: vi.fn(() => Promise.resolve()),
    loadTrackedAddresses: vi.fn(() => Promise.resolve([])),
    _data: data,
  } as unknown as StorageProvider & { _data: Map<string, string> };
}

/**
 * A transport mock backed by a shared directory so A resolves B (and vice-versa).
 * `resolve()` returns a real {@link PeerInfo} carrying the peer's REAL chainPubkey —
 * exactly what the courier addresses by — so the A→B send is a genuine resolution.
 */
function makeTransport(directory: Map<string, PeerInfo>): TransportProvider {
  return {
    id: 'mem-transport',
    name: 'Mem Transport',
    type: 'p2p' as const,
    setIdentity: vi.fn(() => Promise.resolve()),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setFallbackSince: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('transfer-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('request-id'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('response-id'),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    publishIdentityBinding: vi.fn().mockResolvedValue(true),
    recoverNametag: vi.fn().mockResolvedValue(null),
    // No Nostr-side pending events — the courier inbox is the delivery channel.
    fetchPendingEvents: vi.fn().mockResolvedValue([]),
    // The directory IS the resolution: hand back the peer's real chainPubkey.
    resolve: vi.fn((id: string) => Promise.resolve(directory.get(id) ?? null)),
    onEvent: vi.fn().mockReturnValue(() => {}),
    getRelays: vi.fn(() => []),
    getConnectedRelays: vi.fn(() => []),
  } as unknown as TransportProvider;
}

/**
 * An oracle that exposes the three engine-config accessors so Sphere's
 * `buildTokenEngine` PROCEEDS (and hits our mocked `createSphereTokenEngine`). The
 * trust-base JSON is a sentinel — the FakeTokenEngine ignores it; we only need
 * `buildTokenEngine`'s non-null guard to pass.
 */
function makeOracle(): OracleProvider {
  return {
    id: 'mem-oracle',
    name: 'Mem Oracle',
    type: 'network' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    initialize: vi.fn().mockResolvedValue(undefined),
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    // The three members buildTokenEngine reads (engine then built via the mock).
    getTrustBaseJson: () => ({ networkId: 4 }),
    getAggregatorUrl: () => 'http://localhost/gateway',
    getApiKey: () => 'sk_test',
    onEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as OracleProvider;
}

/** A no-op local token store, so the vault joins it ADDITIVELY (never replaces it). */
function makeLocalTokenStore(): TokenStorageProvider<TxfStorageDataBase> {
  let saved: TxfStorageDataBase | null = null;
  return {
    id: 'local-tokens',
    name: 'Local',
    type: 'local' as const,
    setIdentity: vi.fn(),
    initialize: vi.fn(() => Promise.resolve(true)),
    shutdown: vi.fn(() => Promise.resolve()),
    connect: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(() => Promise.resolve()),
    isConnected: vi.fn(() => true),
    getStatus: vi.fn(() => 'connected' as const),
    load: vi.fn(() => Promise.resolve(
      saved
        ? { success: true as const, data: saved, source: 'local' as const, timestamp: Date.now() }
        : { success: false as const, source: 'local' as const, timestamp: Date.now() },
    )),
    save: vi.fn((d: TxfStorageDataBase) => { saved = d; return Promise.resolve({ success: true as const, timestamp: Date.now() }); }),
    sync: vi.fn((localData: TxfStorageDataBase) => {
      saved = localData;
      return Promise.resolve({ success: true as const, merged: localData, added: 0, removed: 0, conflicts: 0 });
    }),
    onEvent: vi.fn().mockReturnValue(() => {}),
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
}

/** Reset the Sphere singleton so a second wallet can init in the same process. */
function resetSphereSingleton(): void {
  (Sphere as unknown as { instance: Sphere | null }).instance = null;
}

let server: BootedTokenApi;
const directory = new Map<string, PeerInfo>();

beforeAll(async () => {
  server = await bootTokenApi(NETWORK);
}, 120_000);

afterAll(async () => {
  await server?.stop();
});

afterEach(() => {
  resetSphereSingleton();
  TokenRegistry.resetInstance();
});

describe('Sphere.init vault + courier — in-process token-api', () => {
  it('vault: mint → sync flushes to the vault → a fresh Sphere.load restores from it (XP-invariant address)', async () => {
    const storage = makeStorage();
    const oracle = makeOracle();
    const localTokens = makeLocalTokenStore();

    // CREATE wallet A with the vault flag ON, pointed at the in-process token-api.
    const { sphere, created } = await Sphere.init({
      storage,
      transport: makeTransport(directory),
      oracle,
      tokenStorage: localTokens,
      l1: null,
      network: NETWORK,
      mnemonic: MNEMONIC_A,
      discoverAddresses: false,
      vault: { enabled: true, url: server.baseUrl, deviceId: 'wallet-a' },
    });
    expect(created).toBe(true);

    const identity = sphere.identity!;
    expect(identity.directAddress).toMatch(/^DIRECT:\/\//);
    // The XP-invariant the vault RESERVES is deriveDirectAddress(rawChainPubkey)
    // (see RemoteTokenStorageProvider.planReservedAddress). It is what must survive a
    // wipe; assert the vault round-trips EXACTLY this byte-for-byte below.
    const reservedDirect = await deriveDirectAddress(Buffer.from(identity.chainPubkey, 'hex'));

    // The vault provider was registered ADDITIVELY alongside the local store.
    expect(sphere.hasTokenStorageProvider('remote-token-storage')).toBe(true);
    expect(sphere.hasTokenStorageProvider('local-tokens')).toBe(true);

    // Mint a real (Fake-engine) token to A — confirmed locally.
    const mint = await sphere.payments.mintFungibleToken(COIN, 1234n);
    expect(mint.success).toBe(true);
    const balBefore = sphere.payments.getBalance(COIN);
    expect(balBefore[0]?.totalAmount).toBe('1234');

    // Capture the minted token's genesis id + its flushed UI record. The reload must
    // restore THIS token byte-identical from the vault — a real backup is lossless.
    // The stored UI record's id is `v2_<genesis tokenId>` (PaymentsModule.mintV2) and
    // its vault/TXF storage key is `_<genesis tokenId>` (keyFromTokenId(v2TokenId)).
    const mintedTokenId = mint.tokenId!;
    const storedTokenId = `v2_${mintedTokenId}`;
    const storageKey = `_${mintedTokenId}` as `_${string}`;
    const mintedTokenBefore = sphere.payments.getTokens({ coinId: COIN }).find((t) => t.id === storedTokenId);
    expect(mintedTokenBefore).toBeDefined();

    // FLUSH: sync() drives provider.sync(localData) on the vault → encrypted entries
    // + the reserved DIRECT-address slot land on the real server.
    await sphere.payments.sync();

    // The flush produced real server rows: the writer's own state now knows the token
    // entry + the reserved address slot (>= 2). This is the durable backup landing.
    const writerVault = (sphere.payments as any).getTokenStorageProviders().get('remote-token-storage');
    expect(writerVault.knownCount()).toBeGreaterThanOrEqual(2);

    // Snapshot A's mnemonic so the reload below reads the SAME identity from a cold
    // local store (no token data) — forcing the restore to come from the VAULT.
    const mnemonicCipher = storage._data.get(STORAGE_KEYS_GLOBAL.MNEMONIC);
    expect(mnemonicCipher).toBeTruthy();

    await sphere.destroy();
    resetSphereSingleton();
    TokenRegistry.resetInstance();

    // ── RELOAD: a fresh storage with ONLY the mnemonic (cold local token store) ──
    // A brand-new device: nothing local, only the recovered seed. The vault is the
    // ONLY source of the backed-up state.
    const coldStorage = makeStorage();
    coldStorage._data.set(STORAGE_KEYS_GLOBAL.MNEMONIC, mnemonicCipher!);
    const coldLocalTokens = makeLocalTokenStore(); // empty: no local token data

    const reloaded = await Sphere.init({
      storage: coldStorage,
      transport: makeTransport(directory),
      oracle: makeOracle(),
      tokenStorage: coldLocalTokens,
      l1: null,
      network: NETWORK,
      discoverAddresses: false,
      vault: { enabled: true, url: server.baseUrl, deviceId: 'wallet-a-reload' },
    });
    expect(reloaded.created).toBe(false); // loaded, not created — same wallet recovered

    // The fresh vault provider (cold internal state) reloaded purely from the server.
    // `load()` is idempotent (the rehydration map persists across loads), so it
    // returns the FULL token snapshot even though the provider already self-loaded
    // during init — the reserved DIRECT address (#17) + every backed-up token entry.
    const vault = (reloaded.sphere.payments as any).getTokenStorageProviders().get('remote-token-storage');
    const loaded = await vault.load();
    expect(loaded.success).toBe(true);
    const reloadedData = loaded.data as TxfStorageDataBase;
    expect(reloadedData._meta.address).toBe(reservedDirect); // XP-invariant DIRECT (#17)
    expect(vault.knownCount()).toBeGreaterThanOrEqual(2);

    // REHYDRATION (Phase 7.2): the backed-up token entry is restored under its
    // `_<tokenId>` key, byte-identical to the UI record that was flushed (round-trip
    // equality — the engine re-imports the same blob). Before the fix `load()`
    // returned only `_meta`/`_history`, so this key was ABSENT and balance was lost.
    const tokenKeys = Object.keys(reloadedData).filter(
      (k) => k.startsWith('_') && !['_meta', '_tombstones', '_outbox', '_sent', '_invalid', '_history'].includes(k),
    );
    expect(tokenKeys).toContain(storageKey);
    const restoredRecord = reloadedData[storageKey];
    expect(restoredRecord).toEqual(mintedTokenBefore); // lossless: byte-identical UI record

    // END-TO-END MONEY PROOF: a full PaymentsModule.load() consumes the vault
    // provider (cold local store returns nothing), parses the rehydrated `_<tokenId>`
    // entry and restores the wallet's BALANCE — not just server rows + the address.
    // This is the real token backup: balance survives a wipe to a fresh device.
    await reloaded.sphere.payments.load();
    const restoredBalance = reloaded.sphere.payments.getBalance(COIN);
    expect(restoredBalance[0]?.totalAmount).toBe('1234'); // the backed-up token's value
    const restoredTokens = reloaded.sphere.payments.getTokens({ coinId: COIN });
    expect(restoredTokens.some((t) => t.id === storedTokenId)).toBe(true); // the exact token

    await reloaded.sphere.destroy();
  }, 120_000);

  it('courier: A.send deposits over the courier → B.receive stores + acks → A pollSent GCs the delivery', async () => {
    // ── Wallet B first, so its identity is in the directory before A sends ──
    const storageB = makeStorage();
    const { sphere: walletB } = await Sphere.init({
      storage: storageB,
      transport: makeTransport(directory),
      oracle: makeOracle(),
      tokenStorage: makeLocalTokenStore(),
      l1: null,
      network: NETWORK,
      mnemonic: MNEMONIC_B,
      discoverAddresses: false,
      courier: { enabled: true, url: server.baseUrl },
    });
    const idB = walletB.identity!;
    directory.set(idB.chainPubkey, peerInfoFor(idB));
    directory.set(`@bob`, peerInfoFor(idB));

    resetSphereSingleton();

    // ── Wallet A (the sender), courier ON ──
    const storageA = makeStorage();
    const { sphere: walletA } = await Sphere.init({
      storage: storageA,
      transport: makeTransport(directory),
      oracle: makeOracle(),
      tokenStorage: makeLocalTokenStore(),
      l1: null,
      network: NETWORK,
      mnemonic: MNEMONIC_A,
      discoverAddresses: false,
      courier: { enabled: true, url: server.baseUrl },
    });
    const idA = walletA.identity!;
    directory.set(idA.chainPubkey, peerInfoFor(idA));

    // Fund A and send a slice to B.
    const mint = await walletA.payments.mintFungibleToken(COIN, 1000n);
    expect(mint.success).toBe(true);

    const send = await walletA.payments.send({ recipient: '@bob', amount: '400', coinId: COIN, memo: 'gm' });
    expect(send.status).toBe('completed');

    // The courier was the delivery channel: A journaled a `courier` PENDING entry
    // (GC deferred to a verified ack — NOT removed on bare deposit).
    const pendingAfterSend = readPending(storageA);
    expect(pendingAfterSend).toHaveLength(1);
    expect(pendingAfterSend[0].transport).toBe('courier');
    expect(pendingAfterSend[0].recipientChainPubkey).toBe(idB.chainPubkey);

    // ── B pulls the courier inbox: handleV2Transfer verifies + stores + acks ──
    const before = walletB.payments.getBalance(COIN)[0]?.totalAmount ?? '0';
    expect(before).toBe('0');
    await walletB.payments.receive(); // awaits the courier inbox pull + store
    const afterB = walletB.payments.getBalance(COIN);
    expect(afterB[0]?.totalAmount).toBe('400'); // B's balance reflects the delivery

    // ── A reconciles /sent: a valid recipient ack GCs PENDING_V2_DELIVERIES ──
    // The courier's sender-side delivery gate is `pollSent()` (the same loop load()
    // kicks fire-and-forget). Re-deposit the still-pending courier entry FIRST — this
    // is exactly what `replayPendingV2Deliveries()` does on load(): an idempotent
    // re-deposit (server dedups on the deterministic entryId) that freshly journals the
    // sender-side tracking, immune to the init-time fire-and-forget loop ordering. THEN
    // pollSent sees B's valid ack on /sent and fires onDelivered → GC.
    const courierA = (walletA.payments as any).deps.deliveryTransport;
    const pend = pendingAfterSend[0];
    await courierA.deposit({
      recipientChainPubkey: pend.recipientChainPubkey,
      senderChainPubkey: idA.chainPubkey,
      transferId: pend.transferId,
      tokenBlobHex: pend.tokenBlob,
      memo: pend.memo,
    });
    await courierA.pollSent();
    expect(readPending(storageA)).toHaveLength(0);

    await walletA.destroy();
    resetSphereSingleton();
    await walletB.destroy();
  }, 120_000);
});

/** Build a PeerInfo carrying the wallet's REAL chainPubkey (what the courier addresses). */
function peerInfoFor(id: FullIdentity): PeerInfo {
  return {
    transportPubkey: id.chainPubkey.slice(2), // 32-byte x-only, mirrors Sphere's transport pubkey
    chainPubkey: id.chainPubkey,
    l1Address: id.l1Address,
    directAddress: id.directAddress ?? '',
    timestamp: Date.now(),
  };
}

/** One journaled finished-but-undelivered v2 blob (the fields the test reads). */
interface PendingDelivery {
  transport?: string;
  recipientChainPubkey: string;
  transferId: string;
  tokenBlob: string;
  memo?: string;
  entryId?: string;
}

/** Read the per-address PENDING_V2_DELIVERIES journal straight from the mock storage. */
function readPending(storage: StorageProvider & { _data: Map<string, string> }): PendingDelivery[] {
  const raw = storage._data.get(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES);
  return raw ? (JSON.parse(raw) as PendingDelivery[]) : [];
}
