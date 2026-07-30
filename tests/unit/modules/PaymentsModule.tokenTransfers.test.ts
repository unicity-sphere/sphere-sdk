/**
 * PaymentsModule.send() — v2 engine path: failure modes, recovery,
 * SENT history metadata and TransferResult.tokenTransfers entries.
 *
 * Complements PaymentsModule.v2-receive.test.ts (which covers the send
 * happy-path wire format, split balances and memo placement).
 *
 * Composition: the REAL FULL wallet-api preset (impl/shared/wallet-api/
 * composition.ts → createWalletApiProviders) against the in-process
 * FakeWalletApi — thin server-custody storage + WalletApiMailboxProvider
 * delivery (custody 'inventory') + the WalletApiClient, exactly as shipped.
 * The previous memory-delivery / mock-token-storage / no-client wiring was a
 * composition that cannot exist in production (and `assertLegalCustodyComposition`
 * refuses the inventory-custody half of it).
 *
 * "Nothing hit the wire" is therefore asserted against the RECIPIENT'S REAL
 * MAILBOX on the fake backend (plus the delivery port's own call log), not
 * against a double's `delivered` array.
 */
import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import type { TransportProvider } from '../../../transport';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { SphereError } from '../../../core/errors';
import type { FakeWalletApi } from '../../support/fake-wallet-api';
import { testIdentity } from '../../support/wallet-api-test-helpers';
import {
  fullIdentity,
  peerInfoOf,
  makeFullPresetWallet,
  seedServerToken,
  startFakeWalletApi,
  type PresetWallet,
} from '../../support/preset-wallet';

const UCT = '11'.repeat(32); // v2 coin ids are lowercase hex

const ALICE = testIdentity(21); // the wallet under test (real keypair — the backend verifies signatures)
const BOB = testIdentity(22); // the recipient
/** Bob's transport-layer coordinates, as the transport would publish them. */
const BOB_PEER = peerInfoOf(BOB, 'bob');

/** Bob is reachable AND has published a chain identity — the happy peer. */
function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: BOB.chainPubkey,
      transportPubkey: BOB_PEER.transportPubkey,
      directAddress: BOB_PEER.directAddress,
      nametag: 'bob',
    }),
    resolveNametagInfo: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
    publishNametag: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequest: vi.fn().mockResolvedValue(undefined),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

let deviceSeq = 0;

/**
 * Alice's wallet over the full wallet-api preset.
 *
 * `engine`: omitted → a default FakeTokenEngine bound to Alice's pubkey;
 * `null` → no engine wired at all; a factory → a custom engine, still bound to
 * Alice's pubkey (engine and wallet pubkeys MUST agree).
 */
async function setup(engine?: ((c: { chainPubkey?: Uint8Array }) => FakeTokenEngine) | null): Promise<{
  fake: FakeWalletApi;
  wallet: PresetWallet;
  module: PresetWallet['module'];
  engine: FakeTokenEngine | null;
  emitEvent: PresetWallet['emitEvent'];
  transport: TransportProvider;
  delivery: PresetWallet['delivery'];
}> {
  const { fake, baseUrl, stop } = await startFakeWalletApi();
  cleanups.push(stop);
  const transport = mockTransport();
  deviceSeq += 1;
  const wallet = makeFullPresetWallet({
    baseUrl,
    network: fake.network,
    who: ALICE,
    deviceId: `d-tt-${deviceSeq}`,
    transport,
    ...(engine !== undefined ? { engine } : {}),
  });
  cleanups.push(wallet.destroy);
  return {
    fake, wallet, module: wallet.module, engine: wallet.engine,
    emitEvent: wallet.emitEvent, transport, delivery: wallet.delivery,
  };
}

/** Watch the REAL delivery port: the closest analogue of the old double's `delivered`. */
function watchDelivery(wallet: { delivery: PresetWallet['delivery'] }) {
  const deliver = vi.spyOn(wallet.delivery, 'deliver');
  const deliverBatch = vi.spyOn(wallet.delivery, 'deliverBatch');
  return {
    /** Every (recipientPubkey, blob) pair handed to the rail, batch legs flattened. */
    legs(): { recipientPubkey: string; blob: Uint8Array }[] {
      const out: { recipientPubkey: string; blob: Uint8Array }[] = [];
      for (const [recipientPubkey, blob] of deliver.mock.calls) out.push({ recipientPubkey, blob });
      for (const [recipientPubkey, blobs] of deliverBatch.mock.calls) {
        for (const blob of blobs) out.push({ recipientPubkey, blob });
      }
      return out;
    },
  };
}

/** What actually reached Bob — the recipient's real mailbox on the backend. */
function bobsMailbox(fake: FakeWalletApi) {
  return fake.listMailboxEntries(BOB.chainPubkey);
}

async function sendError(promise: Promise<unknown>): Promise<SphereError> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(SphereError);
  return err as SphereError;
}

describe('send — recipient resolution failures', () => {
  it('fails with INVALID_RECIPIENT when transport.resolve returns null', async () => {
    const { fake, wallet, module, transport } = await setup();
    await seedServerToken(fake, wallet, UCT, 100n);
    await module.load();
    const rail = watchDelivery(wallet);
    (transport.resolve as Mock).mockResolvedValue(null);

    const err = await sendError(module.send({ recipient: '@ghost', amount: '100', coinId: UCT }));
    expect(err.code).toBe('INVALID_RECIPIENT');

    // Nothing left the wallet and nothing hit the wire.
    expect(rail.legs()).toHaveLength(0);
    expect(bobsMailbox(fake)).toHaveLength(0);
    expect(module.getTokens()).toHaveLength(1);
  });

  it('fails with INVALID_RECIPIENT when the peer has no published chain pubkey', async () => {
    const { fake, wallet, module, transport } = await setup();
    await seedServerToken(fake, wallet, UCT, 100n);
    await module.load();
    const rail = watchDelivery(wallet);
    // Peer is reachable on transport but never published a chain identity.
    (transport.resolve as Mock).mockResolvedValue({
      transportPubkey: BOB_PEER.transportPubkey, directAddress: BOB_PEER.directAddress, nametag: 'bob',
    });

    const err = await sendError(module.send({ recipient: '@bob', amount: '100', coinId: UCT }));
    expect(err.code).toBe('INVALID_RECIPIENT');
    expect(err.message).toContain('no published identity');
    expect(rail.legs()).toHaveLength(0);
    expect(bobsMailbox(fake)).toHaveLength(0);
  });
});

describe('send — engine availability', () => {
  it('fails with AGGREGATOR_ERROR when no token engine is configured', async () => {
    const { fake, wallet, module } = await setup(null); // no engine wired
    await module.load();
    const rail = watchDelivery(wallet);

    const err = await sendError(module.send({ recipient: '@bob', amount: '100', coinId: UCT }));
    expect(err.code).toBe('AGGREGATOR_ERROR');
    expect(err.message).toContain('Token engine unavailable');
    expect(rail.legs()).toHaveLength(0);
    expect(bobsMailbox(fake)).toHaveLength(0);
  });
});

describe('send — insufficient balance', () => {
  it('fails with SEND_INSUFFICIENT_BALANCE when the wallet is empty', async () => {
    const { fake, wallet, module } = await setup();
    await module.load();
    const rail = watchDelivery(wallet);

    const err = await sendError(module.send({ recipient: '@bob', amount: '100', coinId: UCT }));
    expect(err.code).toBe('SEND_INSUFFICIENT_BALANCE');
    expect(err.message).toContain('Insufficient balance');
    expect(rail.legs()).toHaveLength(0);
    expect(bobsMailbox(fake)).toHaveLength(0);
  });
});

describe('send — failure recovery (engine.transfer throws mid-send)', () => {
  class ExplodingTransferEngine extends FakeTokenEngine {
    public override transfer(): Promise<never> {
      return Promise.reject(new Error('engine transfer failed mid-send'));
    }
  }

  it('restores the source token to confirmed and notifies the spend queue', async () => {
    const { fake, wallet, module, emitEvent } = await setup((c) => new ExplodingTransferEngine(c));
    await seedServerToken(fake, wallet, UCT, 100n);
    await module.load();
    const rail = watchDelivery(wallet);
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const notifySpy = vi.spyOn((module as any).spendQueue, 'notifyChange');

    await expect(
      module.send({ recipient: '@bob', amount: '100', coinId: UCT })
    ).rejects.toThrow('engine transfer failed mid-send');

    // Source token is back in the wallet, spendable again.
    const tokens = module.getTokens();
    expect(tokens).toHaveLength(1);
    expect(tokens[0].status).toBe('confirmed');

    // Queue is woken AFTER restoration so queued sends see the restored token.
    expect(notifySpy).toHaveBeenCalledWith(UCT);

    // Failure is surfaced; nothing was handed to the recipient, no SENT history.
    /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
    const failed = emitEvent.mock.calls.find((c: any[]) => c[0] === 'transfer:failed');
    expect(failed).toBeDefined();
    expect(failed![1].status).toBe('failed');
    expect(failed![1].error).toContain('engine transfer failed mid-send');
    expect(rail.legs()).toHaveLength(0);
    expect(bobsMailbox(fake)).toHaveLength(0);
    expect(module.getHistory().filter((h) => h.type === 'SENT')).toHaveLength(0);
    // Nothing was spent server-side either — the source row is still active.
    expect(fake.getRow(ALICE.chainPubkey, tokens[0].id.replace(/^v2_/, ''))).toMatchObject({ status: 'active' });
  });
});

describe('send — SENT history entry', () => {
  it('records a single SENT entry with recipient metadata, memo and token breakdown', async () => {
    const { fake, wallet, module } = await setup();
    await seedServerToken(fake, wallet, UCT, 100n);
    await module.load();
    const sourceTokenId = module.getTokens()[0].id;

    const result = await module.send({ recipient: '@bob', amount: '100', coinId: UCT, memo: 'lunch' });

    const sent = module.getHistory().filter((h) => h.type === 'SENT');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: 'SENT',
      amount: '100',
      coinId: UCT,
      memo: 'lunch',
      transferId: result.id,
      recipientPubkey: BOB_PEER.transportPubkey,
      recipientNametag: 'bob',
      recipientAddress: BOB_PEER.directAddress,
      tokenIds: [{ id: sourceTokenId, amount: '100', source: 'direct' }],
    });
    expect(sent[0].timestamp).toBeGreaterThan(0);
  });
});

describe('TransferResult.tokenTransfers', () => {
  it('produces one direct entry per whole token consumed (multi-token send)', async () => {
    const { fake, wallet, module } = await setup();
    // 100 + 40 exactly covers 140 → both tokens go whole, no split.
    await seedServerToken(fake, wallet, UCT, 100n);
    await seedServerToken(fake, wallet, UCT, 40n);
    await module.load();
    const rail = watchDelivery(wallet);
    const sourceIds = module.getTokens().map((t) => t.id).sort();

    const result = await module.send({ recipient: '@bob', amount: '140', coinId: UCT });

    expect(result.status).toBe('completed');
    expect(result.tokenTransfers).toHaveLength(2);
    for (const tt of result.tokenTransfers) {
      expect(tt).toEqual({ sourceTokenId: tt.sourceTokenId, method: 'direct' });
    }
    expect(result.tokenTransfers.map((tt) => tt.sourceTokenId).sort()).toEqual(sourceIds);

    // One V2_TRANSFER wire payload — one mailbox entry — per consumed token,
    // all under this send's transferId, but a single SENT entry.
    expect(rail.legs()).toHaveLength(2);
    const entries = bobsMailbox(fake);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.transferId))).toEqual(new Set([result.id]));
    expect(module.getHistory().filter((h) => h.type === 'SENT')).toHaveLength(1);
    expect(module.getTokens()).toHaveLength(0);
  });

  it('produces a single split entry for a split send and no txHash field', async () => {
    const { fake, wallet, module } = await setup();
    await seedServerToken(fake, wallet, UCT, 1000n);
    await module.load();
    const sourceTokenId = module.getTokens()[0].id;

    const result = await module.send({ recipient: '@bob', amount: '300', coinId: UCT });

    expect(result.tokenTransfers).toEqual([{ sourceTokenId, method: 'split' }]);
    // txHash was replaced by tokenTransfers long ago and must not resurface.
    expect(result).not.toHaveProperty('txHash');
  });
});

describe('send — transferMode is ignored (single engine path)', () => {
  it('sends the same V2_TRANSFER wire payload regardless of transferMode', async () => {
    const { fake, wallet, module } = await setup();
    await seedServerToken(fake, wallet, UCT, 100n);
    await seedServerToken(fake, wallet, UCT, 100n);
    await module.load();
    const rail = watchDelivery(wallet);

    const conservative = await module.send({ recipient: '@bob', amount: '100', coinId: UCT, transferMode: 'conservative' });
    const instant = await module.send({ recipient: '@bob', amount: '100', coinId: UCT, transferMode: 'instant' });

    expect(conservative.status).toBe('completed');
    expect(instant.status).toBe('completed');

    // Two deliveries, both non-empty blobs addressed to Bob's CHAIN pubkey…
    const legs = rail.legs();
    expect(legs).toHaveLength(2);
    for (const leg of legs) {
      expect(leg.blob.byteLength).toBeGreaterThan(0);
      expect(leg.recipientPubkey).toBe(BOB.chainPubkey);
    }
    // …and both landed in Bob's mailbox, one per send.
    const entries = bobsMailbox(fake);
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((e) => e.transferId))).toEqual(new Set([conservative.id, instant.id]));
  });
});
