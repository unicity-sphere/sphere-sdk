/**
 * v2 transfer RECEIVER — handleV2Transfer (B1, path B).
 *
 * Sender-driven model: the sender hands a FINISHED token (a V2_TRANSFER payload
 * carrying the token blob), the receiver decodes it via the engine and just
 * STORES it as a confirmed token — no commitment / inclusion-proof /
 * finalization round-trip. Clean harness (NO SDK vi.mock) so FakeTokenEngine and
 * the engine-injected SpendQueue run end-to-end.
 *
 * Composition: the SHIPPED own-storage wallet-api preset
 * (`createOwnStorageWalletApiProviders` — local token storage keeps custody,
 * `WalletApiMailboxProvider` custody 'external' is the delivery rail, and the
 * REAL `WalletApiClient` is the `walletApi` port) against the in-process
 * {@link FakeWalletApi}. There is no delivery double: what a send hands the rail
 * is asserted by reading the recipient's SERVER mailbox and by letting a real
 * recipient wallet pull it (`receive()`), which is what a wallet actually does.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPaymentsModule, type PaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import { FakeTokenEngine, decodeFakeTokenAssets, decodeFakeTokenId } from '../token-engine/FakeTokenEngine';
import { encodeTokenBlob, decodeTokenBlob } from '../../../token-engine/token-blob';
import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { deriveDeliveryEncryptionKey, decryptDeliveryBundle } from '../../../core/delivery-envelope';
import { FIELD_ENVELOPE_PREFIX } from '../../../core/field-encryption';
import type { V2TransferPayload } from '../../../types/v2-transfer';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';
import { WalletApiClient } from '../../../wallet-api';
import { WalletApiMailboxProvider } from '../../../impl/shared/wallet-api';

const UCT = '11'.repeat(32); // v2 coin ids are lowercase hex
/** This wallet. Derived keypair — the wallet-api auth challenge is really signed. */
const ALICE = testIdentity(21);
/** '@bob' — the recipient the mock transport resolves to. */
const BOB = testIdentity(22);
const SENDER_TRANSPORT_PUBKEY = 'cc'.repeat(32);
const FOREIGN_PUBKEY = new Uint8Array([0x02, ...new Array<number>(32).fill(7)]); // 33 bytes, NOT this wallet

function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    directAddress: `DIRECT://${id.chainPubkey.slice(0, 12)}`,
  };
}

function mockStorage(): { provider: StorageProvider; map: Map<string, string> } {
  const s = new Map<string, string>();
  const provider = {
    id: 's', name: 's', type: 'local', connect: vi.fn(), disconnect: vi.fn(),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => s.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { s.set(k, v); }),
    remove: vi.fn(async (k: string) => { s.delete(k); }),
    has: vi.fn(async (k: string) => s.has(k)),
    keys: vi.fn(async () => [...s.keys()]),
    clear: vi.fn(async () => { s.clear(); }),
  } as unknown as StorageProvider;
  return { provider, map: s };
}

function mockHistoryStore() {
  const entries = new Map<string, HistoryRecord>();
  return {
    addHistoryEntry: vi.fn(async (e: HistoryRecord) => { entries.set(e.dedupKey, e); }),
    getHistoryEntries: vi.fn(async () => [...entries.values()]),
    hasHistoryEntry: vi.fn(async (k: string) => entries.has(k)),
    clearHistory: vi.fn(async () => entries.clear()),
    importHistoryEntries: vi.fn(async () => 0),
  };
}

/** Local whole-blob token storage — the own-storage preset's custody port. */
function mockLocalTokenStorage(): TokenStorageProvider<TxfStorageDataBase> {
  let lastSaved: TxfStorageDataBase | null = null;
  return {
    id: 'local', name: 'local', type: 'local',
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true), shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn(async (data: TxfStorageDataBase) => { lastSaved = data; return { success: true, timestamp: 0 }; }),
    load: vi.fn(async () => (lastSaved
      ? { success: true, source: 'local', timestamp: 0, data: lastSaved }
      : { success: false, source: 'local', timestamp: 0 })),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
    ...mockHistoryStore(),
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
}

function mockTransport(nametag = 'alice'): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: BOB.chainPubkey,
      transportPubkey: BOB.chainPubkey.slice(2),
      // a valid DIRECT address (AddressFactory parses the hex after DIRECT://)
      directAddress: 'DIRECT://0000b97b4a83dc3fe636d4f21dbfe4c93149e07367539a059a9c8e64ad7d9fdc30644eaaf64b',
      nametag: 'bob',
    }),
    resolveNametagInfo: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue({
      chainPubkey: ALICE.chainPubkey, transportPubkey: SENDER_TRANSPORT_PUBKEY,
      directAddress: 'DIRECT://sender', nametag,
    }),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
    publishNametag: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequest: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

function mockOracle(): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    isDevMode: () => false,
  } as unknown as OracleProvider;
}

interface Wallet {
  module: PaymentsModule;
  engine: FakeTokenEngine;
  client: WalletApiClient;
  delivery: WalletApiMailboxProvider;
  emitEvent: ReturnType<typeof vi.fn>;
  storage: { provider: StorageProvider; map: Map<string, string> };
  deps: PaymentsModuleDependencies;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function startFake(): Promise<{ fake: FakeWalletApi; baseUrl: string }> {
  const fake = new FakeWalletApi({ decodeAssets: decodeFakeTokenAssets, decodeTokenId: decodeFakeTokenId });
  const baseUrl = await fake.start();
  cleanups.push(() => fake.stop());
  return { fake, baseUrl };
}

let deviceSeq = 0;

/**
 * A wallet over the OWN-STORAGE wallet-api preset (S7: local custody + mailbox
 * delivery 'external' + the real client). The engine's pubkey IS the identity's
 * — incoming-ownership checks (`engine.isOwnedBy`) compare against it.
 */
async function makeWallet(
  baseUrl: string,
  network: string,
  who: { privateKey: string; chainPubkey: string },
  opts: { engine?: FakeTokenEngine; nametag?: string } = {}
): Promise<Wallet> {
  const identity = fullIdentity(who);
  const kv = new MemoryKeyValueStore();
  deviceSeq += 1;
  const client = new WalletApiClient({ baseUrl, network, deviceId: `d-${String(deviceSeq)}`, storage: kv });
  // PaymentsModule.initialize binds the delivery provider's identity (which binds
  // the client's); bind it here too so a standalone client call is authenticated.
  client.setIdentity({ privateKey: identity.privateKey, chainPubkey: identity.chainPubkey });
  const delivery = new WalletApiMailboxProvider({ client, custody: 'external', stateStore: kv });
  const engine = opts.engine ?? new FakeTokenEngine({ chainPubkey: hexToBytes(who.chainPubkey) });
  const storage = mockStorage();
  const emitEvent = vi.fn();
  const deps: PaymentsModuleDependencies = {
    identity,
    storage: storage.provider,
    tokenStorageProviders: new Map([['local', mockLocalTokenStorage()]]),
    transport: mockTransport(opts.nametag),
    oracle: mockOracle(),
    emitEvent,
    tokenEngine: engine,
    delivery,
    walletApi: client,
  };
  const module = createPaymentsModule();
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  await module.load();
  return { module, engine, client, delivery, emitEvent, storage, deps };
}

/** This wallet (alice) on a freshly started fake backend. */
async function setup(engine?: FakeTokenEngine): Promise<Wallet & { fake: FakeWalletApi; baseUrl: string }> {
  const { fake, baseUrl } = await startFake();
  const wallet = await makeWallet(baseUrl, fake.network, ALICE, engine ? { engine } : {});
  return { fake, baseUrl, ...wallet };
}

async function v2Payload(
  engine: FakeTokenEngine, coinId: string, amount: bigint, memo?: string,
  recipientPubkey: Uint8Array = engine.getIdentity().chainPubkey,
  senderNametag?: string,
): Promise<V2TransferPayload> {
  const st = await engine.mint({ recipientPubkey, value: { assets: [{ coinId, amount }] } });
  return { type: 'V2_TRANSFER', version: '2.0', tokenBlob: bytesToHex(encodeTokenBlob(engine.encodeToken(st))), memo, senderNametag };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function deliver(module: PaymentsModule, payload: V2TransferPayload) {
  return (module as any).deliveries.handleV2Transfer(payload, SENDER_TRANSPORT_PUBKEY);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** The one mailbox entry a send deposited for '@bob', with its stored envelope. */
function soleEntryFor(fake: FakeWalletApi, recipientPubkey: string) {
  const entries = fake.listMailboxEntries(recipientPubkey);
  expect(entries).toHaveLength(1);
  const stored = fake.getMailboxEntry(recipientPubkey, entries[0].entryId);
  expect(stored).not.toBeNull();
  return { ...entries[0], ...stored! };
}

/** The S6 envelope the sender attached to a deposit — present and ciphertext. */
function envelopeOf(entry: { memo?: string }): string {
  expect(typeof entry.memo).toBe('string');
  expect(entry.memo!.startsWith(FIELD_ENVELOPE_PREFIX)).toBe(true);
  return entry.memo!;
}

/** Read that envelope as the RECIPIENT can (ECDH — sender key × own key). */
function openEnvelope(
  envelope: string,
  recipient: { privateKey: string },
  senderChainPubkey: string
): { senderNametag?: string; memo?: string } {
  return decryptDeliveryBundle(deriveDeliveryEncryptionKey(recipient.privateKey, senderChainPubkey), envelope);
}

/** On-chain memo of a token a wallet actually holds (its stored blob). */
async function onChainMemoOf(wallet: Wallet, uiTokenId: string): Promise<Uint8Array | null> {
  const held = wallet.module.getTokens().find((t) => t.id === uiTokenId);
  expect(held?.sdkData).toBeDefined();
  const token = await wallet.engine.decodeToken(decodeTokenBlob(hexToBytes(held!.sdkData!)));
  return wallet.engine.readMemo(token);
}

describe('handleV2Transfer — v2 receiver (B1)', () => {
  it('stores the finished token as confirmed', async () => {
    const { module, engine } = await setup();
    await deliver(module, await v2Payload(engine, UCT, 100n));

    const tokens = module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].coinId).toBe(UCT);
    expect(tokens[0].amount).toBe('100');
    expect(tokens[0].status).toBe('confirmed');
  });

  it('emits transfer:incoming with the token, memo and the envelope sender nametag', async () => {
    const { module, engine, emitEvent } = await setup();
    await deliver(module, await v2Payload(engine, UCT, 250n, 'gm', undefined, 'alice'));

    const call = emitEvent.mock.calls.find((c: unknown[]) => c[0] === 'transfer:incoming');
    expect(call).toBeDefined();
    expect(call![1].tokens).toHaveLength(1);
    expect(call![1].memo).toBe('gm');
    expect(call![1].senderNametag).toBe('alice');
  });

  it('leaves the sender nametag unset when the envelope carries none', async () => {
    // The S6 delivery envelope is the ONLY source. There is no transport lookup
    // behind it: a sender that omits the nametag shows as a pubkey, not as a
    // name resolved from somewhere else.
    const { module, engine, emitEvent } = await setup();
    await deliver(module, await v2Payload(engine, UCT, 250n, 'gm'));

    const call = emitEvent.mock.calls.find((c: unknown[]) => c[0] === 'transfer:incoming');
    expect(call).toBeDefined();
    expect(call![1].senderNametag).toBeUndefined();
  });

  it('records a single RECEIVED history entry', async () => {
    const { module, engine } = await setup();
    await deliver(module, await v2Payload(engine, UCT, 100n));

    const received = module.getHistory().filter((h) => h.type === 'RECEIVED');
    expect(received).toHaveLength(1);
    expect(received[0].amount).toBe('100');
  });

  it('dedups a re-delivered identical token (genesis-stable id)', async () => {
    const { module, engine } = await setup();
    const payload = await v2Payload(engine, UCT, 100n);
    await deliver(module, payload);
    await deliver(module, payload);

    expect(module.getTokens()).toHaveLength(1);
  });

  it('rejects a token that fails engine verification (not stored, no event)', async () => {
    class RejectingEngine extends FakeTokenEngine {
      public override verify() {
        return Promise.resolve({ ok: false, reason: 'NOT_AUTHENTICATED' });
      }
    }
    const { module, engine, emitEvent } = await setup(
      new RejectingEngine({ chainPubkey: hexToBytes(ALICE.chainPubkey) })
    );
    await deliver(module, await v2Payload(engine, UCT, 100n));

    expect(module.getTokens()).toHaveLength(0);
    expect(emitEvent.mock.calls.find((c: unknown[]) => c[0] === 'transfer:incoming')).toBeUndefined();
    expect(module.getHistory().filter((h) => h.type === 'RECEIVED')).toHaveLength(0);
  });

  it('rejects a token whose final state is owned by a FOREIGN pubkey (not stored)', async () => {
    const { module, engine, emitEvent } = await setup();
    await deliver(module, await v2Payload(engine, UCT, 100n, undefined, FOREIGN_PUBKEY));

    expect(module.getTokens()).toHaveLength(0);
    expect(emitEvent.mock.calls.find((c: unknown[]) => c[0] === 'transfer:incoming')).toBeUndefined();
  });
});

describe('send — v2 engine path, whole-token (B1)', () => {
  it('round-trips: receive a token, then send it whole via engine.transfer', async () => {
    const { module, engine, fake } = await setup();
    // Receive a 100-UCT token (exact match → no split).
    await deliver(module, await v2Payload(engine, UCT, 100n));
    expect(module.getTokens()).toHaveLength(1);
    const sourceGenesisId = module.getTokens()[0].id.replace(/^v2_/, '');

    const result = await module.send({ recipient: '@bob', amount: '100', coinId: UCT, memo: 'thanks' });

    expect(result.status).toBe('completed');
    // Source token was consumed by the engine and removed from the wallet.
    expect(module.getTokens()).toHaveLength(0);

    // The finished token blob was deposited into BOB's mailbox under this
    // send's transferId (was: `delivery.delivered` on the memory double).
    const entry = soleEntryFor(fake, BOB.chainPubkey);
    expect(entry).toMatchObject({ status: 'unclaimed', transferId: result.id, tokenId: sourceGenesisId });
    expect(entry.senderPubkey).toBe(ALICE.chainPubkey);

    // The memo rode the delivery envelope — operator-blind on the wire (§8.3),
    // readable by the recipient (was: `delivery.delivered[0].options.memo`).
    const envelope = envelopeOf(entry);
    expect(envelope).not.toContain('thanks');
    expect(openEnvelope(envelope, BOB, ALICE.chainPubkey).memo).toBe('thanks');

    // One SENT history entry.
    const history = module.getHistory().filter((h) => h.type === 'SENT');
    expect(history).toHaveLength(1);
    expect(history[0].amount).toBe('100');
  });

  it('the emitted blob decodes back to a token the recipient can store', async () => {
    const { module, engine, fake, baseUrl } = await setup();
    await deliver(module, await v2Payload(engine, UCT, 100n));
    await module.send({ recipient: '@bob', amount: '100', coinId: UCT });

    // A REAL recipient wallet (bob's identity, matching the transferred token's
    // new owner predicate) pulls the deposit off the mailbox and stores it.
    const recipient = await makeWallet(baseUrl, fake.network, BOB);
    const { transfers } = await recipient.module.receive();

    expect(transfers).toHaveLength(1);
    expect(recipient.module.getTokens()).toHaveLength(1);
    expect(recipient.module.getTokens()[0].amount).toBe('100');
    expect(recipient.module.getTokens()[0].status).toBe('confirmed');
  });

  it('splits via engine.split: recipient gets the amount, sender keeps the change', async () => {
    const { module, engine, fake, baseUrl } = await setup();
    // Hold a single 1000-UCT token, send 300 → engine split (300 out, 700 change).
    await deliver(module, await v2Payload(engine, UCT, 1000n));

    const result = await module.send({ recipient: '@bob', amount: '300', coinId: UCT });

    expect(result.status).toBe('completed');
    // Source consumed; the 700 change token remains, confirmed.
    const tokens = module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].amount).toBe('700');
    expect(tokens[0].status).toBe('confirmed');

    // The recipient's deposit decodes to a 300 token (bob's wallet owns it).
    const recipient = await makeWallet(baseUrl, fake.network, BOB);
    await recipient.module.receive();
    expect(recipient.module.getTokens()).toHaveLength(1);
    expect(recipient.module.getTokens()[0].amount).toBe('300');
    expect(fake.listMailboxEntries(BOB.chainPubkey)[0].transferId).toBe(result.id);
  });

  it('puts NO memo on-chain, not even an invoice-shaped one', async () => {
    const { module, engine, fake, baseUrl } = await setup();
    await deliver(module, await v2Payload(engine, UCT, 100n));

    // An INV: memo used to be encoded into the transaction's on-chain data.
    // Payments is detached from accounting, so nothing produces on-chain memos
    // now — every memo is transport-only. This is the whole contract.
    const invoiceId = 'ab'.repeat(32);
    await module.send({ recipient: '@bob', amount: '100', coinId: UCT, memo: `INV:${invoiceId}:F` });

    // Read it off the token the RECIPIENT actually ends up holding.
    const recipient = await makeWallet(baseUrl, fake.network, BOB);
    await recipient.module.receive();
    const held = recipient.module.getTokens();
    expect(held).toHaveLength(1);
    expect(await onChainMemoOf(recipient, held[0].id)).toBeNull();

    // Nor does the invoice reference leak in cleartext on the wire (§8.3) — it
    // is carried, encrypted, as a transport-only memo.
    const envelope = envelopeOf(soleEntryFor(fake, BOB.chainPubkey));
    expect(envelope).not.toContain(invoiceId);
    expect(openEnvelope(envelope, BOB, ALICE.chainPubkey).memo).toBe(`INV:${invoiceId}:F`);
  });

  it('keeps a plain memo transport-only (no on-chain memo, for privacy)', async () => {
    const { module, engine, fake, baseUrl } = await setup();
    await deliver(module, await v2Payload(engine, UCT, 100n));
    await module.send({ recipient: '@bob', amount: '100', coinId: UCT, memo: 'thanks' });

    const recipient = await makeWallet(baseUrl, fake.network, BOB);
    await recipient.module.receive();
    const held = recipient.module.getTokens();
    expect(held).toHaveLength(1);

    expect(await onChainMemoOf(recipient, held[0].id)).toBeNull();  // not put on-chain
    // …it rides the delivery envelope instead: the recipient reads it.
    const incoming = recipient.emitEvent.mock.calls.find((c: unknown[]) => c[0] === 'transfer:incoming');
    expect(incoming).toBeDefined();
    expect(incoming![1].memo).toBe('thanks');
    expect(envelopeOf(soleEntryFor(fake, BOB.chainPubkey))).not.toContain('thanks');
  });
});
