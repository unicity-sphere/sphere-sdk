/**
 * PaymentsModule.receive() must observe deliveries present as of call-time —
 * the cross-session-sync regression (#570):
 *
 * The §9 wake/poll work added background delivery pumps. `pumpIncomingDeliveries()`
 * COALESCES concurrent runs onto one in-flight pump. That is correct for the
 * background pumps (a wake is a best-effort nudge), but WRONG for `receive()`:
 * receive()'s contract is to load+return every delivery available as of the
 * call. When a background pump (triggered by an earlier wake/poll) is in-flight
 * and queried the mailbox BEFORE a just-arrived delivery, a coalescing
 * receive() awaits that stale pump and returns WITHOUT the token — `{ transfers:
 * [] }` and getTokens() missing it. (Surfaced by the multi-session harness;
 * broke two-wallet-flow's payment-request PR test.)
 *
 * The fix gives receive() a FRESH pull: it awaits any in-flight background pump,
 * then starts a new one that observes the mailbox as of NOW. This test
 * reproduces the race deterministically with a delivery provider that lets the
 * background pump snapshot the EMPTY mailbox and hold (in-flight) while the
 * delivery lands; receive() must still return it.
 *
 * It FAILS without the fix (receive() coalesces onto the stale snapshot →
 * transfers:[] and getTokens() empty) and PASSES with it.
 */

import WebSocket from 'ws';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPaymentsModule, type PaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider } from '../../../storage';
import type {
  DeliverOptions,
  DeliveryCustody,
  DeliveryDisposition,
  DeliveryProvider,
  DeliveryReceipt,
  IncomingDelivery,
  WakeChannelStatus,
  WakeStream,
} from '../../../transport/delivery-provider';
import { FakeTokenEngine, decodeFakeTokenAssets, decodeFakeTokenId } from '../token-engine/FakeTokenEngine';
import { FakeWalletApi } from '../../support/fake-wallet-api';
import { MemoryKeyValueStore, testIdentity } from '../../support/wallet-api-test-helpers';
import { WalletApiClient, type WebSocketLike } from '../../../wallet-api';
import { WalletApiMailboxProvider, WalletApiTokenStorageProvider } from '../../../impl/shared/wallet-api';
import { encodeTokenBlob } from '../../../token-engine/token-blob';
import { hexToBytes } from '../../../core/crypto';

const UCT = '11'.repeat(32);
const RECEIVER = testIdentity(41);
const SENDER = testIdentity(42);

function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    l1Address: `alpha1${id.chainPubkey.slice(0, 8)}`,
    directAddress: `DIRECT://${id.chainPubkey.slice(0, 12)}`,
    transportPubkey: id.chainPubkey.slice(2),
  };
}

function mockStorage(): StorageProvider {
  const s = new Map<string, string>();
  return {
    id: 's', name: 's', type: 'local', connect: vi.fn(), disconnect: vi.fn(),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => s.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { s.set(k, v); }),
    remove: vi.fn(async (k: string) => { s.delete(k); }),
    has: vi.fn(async (k: string) => s.has(k)),
    keys: vi.fn(async () => [...s.keys()]),
    clear: vi.fn(async () => { s.clear(); }),
  } as unknown as StorageProvider;
}

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    sendPaymentRequest: vi.fn().mockResolvedValue('nostr-event'),
    sendPaymentRequestResponse: vi.fn().mockResolvedValue('nostr-event'),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn(async (recipient: string) =>
      /^0[23][0-9a-f]{64}$/i.test(recipient)
        ? { chainPubkey: recipient.toLowerCase(), transportPubkey: recipient.slice(2), directAddress: `DIRECT://${recipient.slice(0, 12)}` }
        : null
    ),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
  } as unknown as TransportProvider;
}

function mockOracle(): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    isDevMode: () => false,
  } as unknown as OracleProvider;
}

/** A manual-reset gate: callers `await wait()`; the test `open()`s it once. */
function makeGate(): { wait: () => Promise<void>; open: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { wait: () => promise, open: () => resolve() };
}

/**
 * A {@link DeliveryProvider} wrapper that lets a test make a BACKGROUND pump go
 * in-flight against a STALE mailbox snapshot. `incoming()` eagerly drains the
 * real provider's feed AT CALL TIME (this performs the mailbox query against the
 * current server state — the staleness point), then, on the first call only,
 * awaits a gate before yielding. So the test can: fire a wake → the background
 * pump queries the (empty) mailbox and HOLDS in-flight → the delivery lands →
 * receive() runs. Without the fresh-pull fix, receive() coalesces onto this
 * held, stale pump and never sees the delivery.
 */
class GatedDeliveryProvider implements DeliveryProvider {
  readonly custody: DeliveryCustody;
  private gated = true;
  /** Resolves once the first `incoming()` has captured its (empty) snapshot. */
  readonly snapshotTaken: Promise<void>;
  private markSnapshotTaken!: () => void;

  constructor(private readonly inner: DeliveryProvider, private readonly gate: { wait: () => Promise<void> }) {
    this.custody = inner.custody;
    this.snapshotTaken = new Promise<void>((r) => { this.markSnapshotTaken = r; });
  }

  setIdentity(identity: { privateKey: string; chainPubkey: string }): void {
    this.inner.setIdentity?.(identity);
  }

  bindDeliveryKeys(derive: (blobBytes: Uint8Array) => Promise<{ tokenId: string; stateHash: string }>): void {
    this.inner.bindDeliveryKeys?.(derive);
  }

  deliver(recipientPubkey: string, blob: Uint8Array, options: DeliverOptions): Promise<DeliveryReceipt> {
    return this.inner.deliver(recipientPubkey, blob, options);
  }

  ack(deliveryId: string, disposition: DeliveryDisposition): Promise<void> {
    return this.inner.ack(deliveryId, disposition);
  }

  onWake(callback: (stream: WakeStream) => void, onStatus?: (status: WakeChannelStatus) => void): () => void {
    return this.inner.onWake?.(callback, onStatus) ?? (() => {});
  }

  async *incoming(sinceCursor?: string): AsyncIterable<IncomingDelivery> {
    // Drain the real feed NOW — this is when the mailbox is queried, so the
    // snapshot reflects the server state AT CALL TIME (the staleness point).
    const buffered: IncomingDelivery[] = [];
    for await (const d of this.inner.incoming(sinceCursor)) buffered.push(d);
    if (this.gated) {
      this.gated = false;
      this.markSnapshotTaken(); // tell the test the stale snapshot is captured
      await this.gate.wait(); // hold this pump in-flight while the delivery lands
    }
    yield* buffered;
  }
}

interface Wallet {
  module: PaymentsModule;
  engine: FakeTokenEngine;
  delivery: DeliveryProvider;
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

function makeWallet(
  baseUrl: string,
  network: string,
  who: { privateKey: string; chainPubkey: string },
  deviceId: string,
  wrapDelivery?: (inner: WalletApiMailboxProvider) => DeliveryProvider
): Wallet {
  const identity = fullIdentity(who);
  const kv = new MemoryKeyValueStore();
  const client = new WalletApiClient({
    baseUrl,
    network,
    deviceId,
    storage: kv,
    // Node < 22 has no global WebSocket — inject `ws` so the wake socket connects.
    webSocketFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
  });
  const tokenStorage = new WalletApiTokenStorageProvider({ client, stateStore: kv });
  tokenStorage.setIdentity(identity);
  const inner = new WalletApiMailboxProvider({ client, custody: 'inventory', stateStore: kv });
  const delivery = wrapDelivery ? wrapDelivery(inner) : inner;
  const engine = new FakeTokenEngine({ chainPubkey: hexToBytes(who.chainPubkey) });
  const deps: PaymentsModuleDependencies = {
    identity,
    storage: mockStorage(),
    tokenStorageProviders: new Map([[tokenStorage.id, tokenStorage]]),
    transport: mockTransport(),
    oracle: mockOracle(),
    emitEvent: vi.fn(),
    tokenEngine: engine,
    delivery,
    walletApi: client,
  };
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return { module, engine, delivery };
}

/** Poll a predicate up to `timeoutMs` (well under the 30s poll backstop). */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('waitFor: predicate never became true');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('receive() observes deliveries as of call-time (no coalescing onto a stale background pump)', () => {
  it('returns a delivery that lands while a background pump is held in-flight on the empty mailbox', async () => {
    const { fake, baseUrl } = await startFake();
    const gate = makeGate();
    let gated!: GatedDeliveryProvider;
    const receiver = makeWallet(baseUrl, fake.network, RECEIVER, 'recv-a', (inner) => {
      gated = new GatedDeliveryProvider(inner, gate);
      return gated;
    });
    const sender = makeWallet(baseUrl, fake.network, SENDER, 'send-a');

    await receiver.module.load();
    expect(receiver.module.getTokens()).toHaveLength(0);

    // The receiver's wake socket must be live so a wake can drive a background pump.
    await waitFor(() => fake.socketCount(RECEIVER.chainPubkey) >= 1);

    // 1) Fire a mailbox wake → handleWake() starts a BACKGROUND pump. The gated
    //    provider queries the (still empty) mailbox and HOLDS in-flight.
    fake.wakeOwner(RECEIVER.chainPubkey, 'mailbox');
    await gated.snapshotTaken; // the stale (empty) snapshot is now captured + the pump is in-flight

    // 2) NOW a delivery lands: the sender mints a token and deposits it into the
    //    receiver's mailbox. (The deposit's own wake coalesces onto the held pump.)
    const minted = await sender.engine.mint({
      recipientPubkey: receiver.engine.getIdentity().chainPubkey, // owned by the receiver
      value: { assets: [{ coinId: UCT, amount: 400n }] },
    });
    const blob = encodeTokenBlob(sender.engine.encodeToken(minted));
    // The sender's module already bound deliveryKeys + identity onto its
    // delivery provider at init; deposit straight through the port.
    await sender.delivery.deliver(RECEIVER.chainPubkey, blob, { transferId: 'race-transfer-1' });

    // Confirm the delivery is genuinely present server-side before we receive().
    await waitFor(async () => fake.listMailboxEntries(RECEIVER.chainPubkey).length === 1);

    // 3) receive() is called while the stale background pump is still in-flight.
    //    Release the gate concurrently so the held pump can resolve — receive()
    //    must NOT just return that stale pump's (empty) result.
    const receivePromise = receiver.module.receive();
    gate.open();
    const result = await receivePromise;

    // The fix makes receive() fresh-pull after awaiting the in-flight pump, so
    // the just-landed delivery is returned AND reflected in getTokens()
    // synchronously after the await (converged state — not a call-count).
    expect(result.transfers).toHaveLength(1);
    expect(result.transfers[0].tokens[0]).toMatchObject({ amount: '400', coinId: UCT });
    expect(receiver.module.getTokens()).toContainEqual(
      expect.objectContaining({ amount: '400', coinId: UCT, status: 'confirmed' })
    );
  });
});
