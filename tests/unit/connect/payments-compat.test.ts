/**
 * §4 wire-compat conformance (docs/PAYMENTS-V2-DESIGN.md, manifest E): against a host
 * whose Sphere runs the payments-v2 facade, every old query keeps its wire shape and
 * every old event name a dApp can `sphere_subscribe` to fires with its old payload shape.
 *
 * The mock Sphere's `payments` getter THROWS (exactly like the real v2 Sphere), so every
 * passing query here is also proof the adapter never touches the legacy surface. Events
 * are driven as the facade drives them — the 8 v2 bus events, typed against
 * `PaymentsV2Events` so a facade contract drift breaks this suite.
 *
 * Harness mirrors tests/unit/connect/lock.test.ts (recorded mock transport pair).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectHost } from '../../../connect/host/ConnectHost';
import { ConnectClient } from '../../../connect/client/ConnectClient';
import type { ConnectTransport } from '../../../connect/types';
import type { SphereConnectMessage } from '../../../connect/protocol';
import { RPC_METHODS } from '../../../connect/protocol';
import { PERMISSION_SCOPES } from '../../../connect/permissions';
import type { PaymentsV2Events, PaymentRequestView, HistoryEntry } from '../../../modules/payments-v2/api';
import type { TransferResult } from '../../../types';

// ===========================================================================
// Mock transport pair (records both directions)
// ===========================================================================

interface MockPair {
  host: ConnectTransport;
  client: ConnectTransport;
  hostSent: SphereConnectMessage[];
  clientSent: SphereConnectMessage[];
}

function createMockTransportPair(): MockPair {
  const hostHandlers = new Set<(msg: SphereConnectMessage) => void>();
  const clientHandlers = new Set<(msg: SphereConnectMessage) => void>();
  const hostSent: SphereConnectMessage[] = [];
  const clientSent: SphereConnectMessage[] = [];

  const host: ConnectTransport = {
    send(msg) {
      hostSent.push(msg);
      for (const h of clientHandlers) h(msg);
    },
    onMessage(handler) {
      hostHandlers.add(handler);
      return () => hostHandlers.delete(handler);
    },
    destroy() { hostHandlers.clear(); },
  };

  const client: ConnectTransport = {
    send(msg) {
      clientSent.push(msg);
      for (const h of hostHandlers) h(msg);
    },
    onMessage(handler) {
      clientHandlers.add(handler);
      return () => clientHandlers.delete(handler);
    },
    destroy() { clientHandlers.clear(); },
  };

  return { host, client, hostSent, clientSent };
}

// ===========================================================================
// Fixtures — facade read results and bus payloads
// ===========================================================================

const COIN = 'a'.repeat(64);
const ALT_COIN = 'b'.repeat(64);

const ASSET_UCT = {
  coinId: COIN, symbol: 'UCT', name: 'Unicity', decimals: 6, totalAmount: '1000000',
  tokenCount: 2, confirmedAmount: '1000000', unconfirmedAmount: '0',
  confirmedTokenCount: 2, unconfirmedTokenCount: 0, transferringTokenCount: 0,
  transferringAmount: '0', priceUsd: 10, priceEur: 9, change24h: 1.5,
  fiatValueUsd: 10.5, fiatValueEur: 9.4,
};
const ASSET_ALT = { ...ASSET_UCT, coinId: ALT_COIN, symbol: 'ALT', fiatValueUsd: 5.25 };

const TOKENS = [
  { id: 'tok1', coinId: COIN, amount: '600000', status: 'confirmed' },
  { id: 'tok2', coinId: ALT_COIN, amount: '400000', status: 'confirmed' },
];

const HISTORY_ENTRY: HistoryEntry = {
  id: 'h1', type: 'SENT', coinId: COIN, amount: '250', symbol: 'UCT',
  timestamp: 1750000000000, transferId: 'tr-h1',
  tokenIds: [{ id: COIN, amount: '250' }],
};

const REQUEST_VIEW: PaymentRequestView = {
  id: 'req1', requestId: 'req1', senderPubkey: '02'.padEnd(66, 'a'), senderNametag: 'bob',
  amount: '500', coinId: COIN, symbol: 'UCT', message: 'pay me',
  timestamp: 1750000001000, status: 'pending',
};
const REQUEST_VIEW_NO_SYMBOL: PaymentRequestView = {
  id: 'req2', requestId: 'req2', senderPubkey: '02'.padEnd(66, 'c'),
  amount: '900', coinId: ALT_COIN, timestamp: 1750000002000, status: 'pending',
};

const DELIVERED: TransferResult = {
  id: 'tr1', status: 'delivered', tokens: [], tokenTransfers: [],
  deliveryPending: false, deliveryState: 'landed',
};
const PENDING_DELIVERY: TransferResult = {
  id: 'tr2', status: 'confirmed', tokens: [], tokenTransfers: [],
  deliveryPending: true, deliveryState: 'pending-delivery',
};
const FAILED: TransferResult = {
  id: 'tr3', status: 'failed', tokens: [], tokenTransfers: [], error: 'boom',
};

// ===========================================================================
// Mock Spheres
// ===========================================================================

/** A Sphere running the v2 facade: `payments` THROWS (as the real getter does under v2);
 *  `paymentsV2` serves reads; the 8 facade events ride the bus via _emit. */
function createV2MockSphere(overrides?: { assets?: unknown[] }) {
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  const assets = overrides?.assets ?? [ASSET_UCT, ASSET_ALT];

  const paymentsV2 = {
    assets: vi.fn((coinId?: string) =>
      Promise.resolve(coinId ? assets.filter((a) => (a as { coinId: string }).coinId === coinId) : assets)),
    tokens: vi.fn((filter?: { coinId?: string }) =>
      filter?.coinId ? TOKENS.filter((t) => t.coinId === filter.coinId) : TOKENS),
    history: vi.fn(() => Promise.resolve({ entries: [HISTORY_ENTRY], more: false, cursor: null })),
    send: vi.fn(),
    mint: vi.fn(),
    receive: vi.fn(),
    requests: {
      create: vi.fn(),
      list: vi.fn(() => [REQUEST_VIEW, REQUEST_VIEW_NO_SYMBOL]),
      pay: vi.fn(),
      decline: vi.fn(),
      dismissProcessed: vi.fn(),
    },
  };

  return {
    identity: { chainPubkey: '02abc123', directAddress: 'DIRECT://test', nametag: 'alice' },
    networkId: 4,
    get payments(): never {
      throw new Error('payments (v1) is disabled by paymentsV2 — use sphere.paymentsV2');
    },
    paymentsV2,
    signMessage: vi.fn(),
    resolve: vi.fn().mockResolvedValue(null),
    on: vi.fn((type: string, handler: (data: unknown) => void) => {
      if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
      eventHandlers.get(type)!.add(handler);
      return () => eventHandlers.get(type)?.delete(handler);
    }),
    /** Drive a facade bus event — typed against the real facade event contract. */
    _emit<K extends keyof PaymentsV2Events>(type: K, data: PaymentsV2Events[K]) {
      for (const h of eventHandlers.get(type) ?? []) h(data);
    },
    /** Mirrors Sphere.destroy() for the lock tests. */
    _destroy() { eventHandlers.clear(); },
    communications: undefined as unknown,
  };
}

/** An old-stack Sphere: `payments` works, no `paymentsV2` — the adapter must stay dormant. */
function createLegacyMockSphere() {
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    identity: { chainPubkey: '02abc123', directAddress: 'DIRECT://test', nametag: 'alice' },
    networkId: 4,
    payments: {
      getBalance: vi.fn().mockReturnValue([{ coinId: COIN, totalAmount: '1000000' }]),
      getAssets: vi.fn().mockResolvedValue([ASSET_UCT]),
      getFiatBalance: vi.fn().mockResolvedValue(10.5),
      getTokens: vi.fn().mockReturnValue(TOKENS),
      getHistory: vi.fn().mockReturnValue([]),
    },
    signMessage: vi.fn(),
    resolve: vi.fn().mockResolvedValue(null),
    on: vi.fn((type: string, handler: (data: unknown) => void) => {
      if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
      eventHandlers.get(type)!.add(handler);
      return () => eventHandlers.get(type)?.delete(handler);
    }),
    _emit(type: string, data: unknown) {
      for (const h of eventHandlers.get(type) ?? []) h(data);
    },
    communications: undefined as unknown,
  };
}

// ===========================================================================
// Harness
// ===========================================================================

const DAPP = { name: 'Compat dApp', url: 'https://compat.app' };

interface Harness {
  pair: MockPair;
  sphere: ReturnType<typeof createV2MockSphere> | ReturnType<typeof createLegacyMockSphere>;
  host: ConnectHost;
  client: ConnectClient;
}

async function connectHarness(
  sphere: Harness['sphere'] = createV2MockSphere(),
): Promise<Harness> {
  const pair = createMockTransportPair();
  const host = new ConnectHost({
    sphere,
    transport: pair.host,
    origin: 'https://compat.app',
    onConnectionRequest: vi.fn().mockResolvedValue({
      approved: true,
      grantedPermissions: Object.values(PERMISSION_SCOPES),
    }),
    onIntent: vi.fn().mockResolvedValue({ result: { success: true } }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const client = new ConnectClient({
    transport: pair.client,
    dapp: DAPP,
    network: { id: 4 },
  });
  await client.connect();

  return { pair, sphere, host, client };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

function eventsOfType(sent: SphereConnectMessage[], event: string): Array<{ event: string; data: unknown }> {
  return sent.filter(
    (m) => m.type === 'event' && (m as { event: string }).event === event,
  ) as unknown as Array<{ event: string; data: unknown }>;
}

/** Subscribe the dApp to an old wire name and give the fire-and-forget RPC time to land. */
async function subscribe(h: Harness, event: string, handler: (data: unknown) => void = () => {}) {
  const unsub = h.client.on(event, handler);
  await tick();
  return unsub;
}

// ===========================================================================
// Queries — old wire shapes served from the facade
// ===========================================================================

describe('§4 compat queries against a v2-facade host', () => {
  let h: Harness;
  let v2: ReturnType<typeof createV2MockSphere>['paymentsV2'];

  beforeEach(async () => {
    const sphere = createV2MockSphere();
    v2 = sphere.paymentsV2;
    h = await connectHarness(sphere);
  });

  it('sphere_getBalance serves assets() — Asset[] shape unchanged', async () => {
    const result = await h.client.query(RPC_METHODS.GET_BALANCE);
    expect(result).toEqual([ASSET_UCT, ASSET_ALT]);
    expect(v2.assets).toHaveBeenCalledWith(undefined);
  });

  it('sphere_getBalance forwards coinId', async () => {
    const result = await h.client.query(RPC_METHODS.GET_BALANCE, { coinId: COIN });
    expect(result).toEqual([ASSET_UCT]);
    expect(v2.assets).toHaveBeenCalledWith(COIN);
  });

  it('sphere_getAssets serves assets()', async () => {
    const result = await h.client.query(RPC_METHODS.GET_ASSETS);
    expect(result).toEqual([ASSET_UCT, ASSET_ALT]);
  });

  it('sphere_getFiatBalance sums priced assets into { fiatBalance }', async () => {
    const result = await h.client.query(RPC_METHODS.GET_FIAT_BALANCE);
    expect(result).toEqual({ fiatBalance: 15.75 });
  });

  it('sphere_getFiatBalance keeps the null "no price data" signal', async () => {
    const unpriced = createV2MockSphere({
      assets: [{ ...ASSET_UCT, fiatValueUsd: null }, { ...ASSET_ALT, fiatValueUsd: null }],
    });
    const h2 = await connectHarness(unpriced);
    const result = await h2.client.query(RPC_METHODS.GET_FIAT_BALANCE);
    expect(result).toEqual({ fiatBalance: null });
  });

  it('sphere_getTokens serves tokens() and forwards the coinId filter', async () => {
    const all = await h.client.query(RPC_METHODS.GET_TOKENS);
    expect(all).toEqual(TOKENS);
    const filtered = await h.client.query(RPC_METHODS.GET_TOKENS, { coinId: ALT_COIN });
    expect(filtered).toEqual([TOKENS[1]]);
    expect(v2.tokens).toHaveBeenLastCalledWith({ coinId: ALT_COIN });
  });

  it('sphere_getTokens still strips sdkData from the wire', async () => {
    const sphere = createV2MockSphere();
    sphere.paymentsV2.tokens = vi.fn(() => [
      { id: 'tok9', coinId: COIN, amount: '1', sdkData: { internal: true } },
    ]) as never;
    const h2 = await connectHarness(sphere);
    const result = await h2.client.query(RPC_METHODS.GET_TOKENS);
    expect(result).toEqual([{ id: 'tok9', coinId: COIN, amount: '1' }]);
  });

  it('sphere_getHistory serves the flat entry array (consumed `timestamp` shape)', async () => {
    const result = (await h.client.query(RPC_METHODS.GET_HISTORY)) as HistoryEntry[];
    expect(result).toEqual([HISTORY_ENTRY]);
    expect(result[0].timestamp).toBe(1750000000000);
    expect(v2.history).toHaveBeenCalledWith(undefined);
  });

  it('sphere_getHistory forwards a numeric limit', async () => {
    await h.client.query(RPC_METHODS.GET_HISTORY, { limit: 5 });
    expect(v2.history).toHaveBeenCalledWith({ limit: 5 });
  });

  /** 3-page facade history fake: h1 → c1 → h2 → c2 → h3 (exhausted). */
  function threePageSphere() {
    const sphere = createV2MockSphere();
    sphere.paymentsV2.history = vi.fn((page?: { before?: string; limit?: number }) => {
      if (page?.before === 'c1') {
        return Promise.resolve({ entries: [{ ...HISTORY_ENTRY, id: 'h2' }], more: true, cursor: 'c2' });
      }
      if (page?.before === 'c2') {
        return Promise.resolve({ entries: [{ ...HISTORY_ENTRY, id: 'h3' }], more: false, cursor: null });
      }
      return Promise.resolve({ entries: [HISTORY_ENTRY], more: true, cursor: 'c1' });
    }) as never;
    return sphere;
  }

  it('parameterless sphere_getHistory follows cursors to the COMPLETE flat array (legacy wire has no cursor)', async () => {
    const sphere = threePageSphere();
    const h2 = await connectHarness(sphere);
    const result = (await h2.client.query(RPC_METHODS.GET_HISTORY)) as HistoryEntry[];
    expect(result.map((entry) => entry.id)).toEqual(['h1', 'h2', 'h3']);
    expect(sphere.paymentsV2.history).toHaveBeenCalledTimes(3);
    expect(sphere.paymentsV2.history).toHaveBeenNthCalledWith(1, undefined);
    expect(sphere.paymentsV2.history).toHaveBeenNthCalledWith(2, { before: 'c1' });
    expect(sphere.paymentsV2.history).toHaveBeenNthCalledWith(3, { before: 'c2' });
  });

  it('an explicit limit keeps the single-page read — no cursor walk', async () => {
    const sphere = threePageSphere();
    const h2 = await connectHarness(sphere);
    const result = (await h2.client.query(RPC_METHODS.GET_HISTORY, { limit: 1 })) as HistoryEntry[];
    expect(result.map((entry) => entry.id)).toEqual(['h1']);
    expect(sphere.paymentsV2.history).toHaveBeenCalledTimes(1);
    expect(sphere.paymentsV2.history).toHaveBeenCalledWith({ limit: 1 });
  });

  it('legacy host is untouched: queries still hit sphere.payments', async () => {
    const legacy = createLegacyMockSphere();
    const h2 = await connectHarness(legacy);
    const result = await h2.client.query(RPC_METHODS.GET_BALANCE);
    expect(result).toEqual([{ coinId: COIN, totalAmount: '1000000' }]);
    expect((legacy as ReturnType<typeof createLegacyMockSphere>).payments.getBalance).toHaveBeenCalled();
  });
});

// ===========================================================================
// Events — every old wire name fires with its old payload shape
// ===========================================================================

describe('§4 compat event re-emission against a v2-facade host', () => {
  let h: Harness;
  let sphere: ReturnType<typeof createV2MockSphere>;

  beforeEach(async () => {
    sphere = createV2MockSphere();
    h = await connectHarness(sphere);
  });

  describe('transfer:updated → transfer:confirmed / :delivery_pending / :failed', () => {
    it('re-emits transfer:confirmed for a settled, delivered result', async () => {
      const received: unknown[] = [];
      await subscribe(h, 'transfer:confirmed', (d) => received.push(d));
      sphere._emit('transfer:updated', DELIVERED);
      const frames = eventsOfType(h.pair.hostSent, 'transfer:confirmed');
      expect(frames).toHaveLength(1);
      expect(frames[0].data).toEqual(DELIVERED);
      // End-to-end: the dApp's own handler receives it under the old name.
      expect(received).toEqual([DELIVERED]);
    });

    it('does NOT emit transfer:confirmed for delivery-pending, failed, or unsettled results', async () => {
      await subscribe(h, 'transfer:confirmed');
      sphere._emit('transfer:updated', PENDING_DELIVERY);
      sphere._emit('transfer:updated', FAILED);
      sphere._emit('transfer:updated', { ...DELIVERED, status: 'pending' });
      expect(eventsOfType(h.pair.hostSent, 'transfer:confirmed')).toHaveLength(0);
    });

    it('re-emits transfer:delivery_pending when deliveryPending is true', async () => {
      await subscribe(h, 'transfer:delivery_pending');
      sphere._emit('transfer:updated', PENDING_DELIVERY);
      sphere._emit('transfer:updated', DELIVERED); // negative
      const frames = eventsOfType(h.pair.hostSent, 'transfer:delivery_pending');
      expect(frames).toHaveLength(1);
      expect(frames[0].data).toEqual(PENDING_DELIVERY);
    });

    // Judgment call #1 (manifest E): design §4 folds :failed into transfer:updated, but the
    // name is dApp-subscribable today — the adapter re-emits it to prevent silent loss.
    it('re-emits transfer:failed when status === failed', async () => {
      await subscribe(h, 'transfer:failed');
      sphere._emit('transfer:updated', FAILED);
      sphere._emit('transfer:updated', DELIVERED); // negative
      const frames = eventsOfType(h.pair.hostSent, 'transfer:failed');
      expect(frames).toHaveLength(1);
      expect(frames[0].data).toEqual(FAILED);
    });
  });

  describe('payment_request:updated → :paid / :rejected / :expired', () => {
    it.each(['paid', 'rejected', 'expired'] as const)(
      're-emits payment_request:%s with the old IncomingPaymentRequest shape',
      async (status) => {
        await subscribe(h, `payment_request:${status}`);
        sphere._emit('payment_request:updated', { id: REQUEST_VIEW.id, status });
        const frames = eventsOfType(h.pair.hostSent, `payment_request:${status}`);
        expect(frames).toHaveLength(1);
        expect(frames[0].data).toEqual({ ...REQUEST_VIEW, status });
      },
    );

    it('fills the required symbol field when the view has none', async () => {
      await subscribe(h, 'payment_request:paid');
      sphere._emit('payment_request:updated', { id: REQUEST_VIEW_NO_SYMBOL.id, status: 'paid' });
      const frames = eventsOfType(h.pair.hostSent, 'payment_request:paid');
      expect(frames[0].data).toEqual({ ...REQUEST_VIEW_NO_SYMBOL, symbol: '', status: 'paid' });
    });

    it('still fires (id + status) when the view is no longer listed', async () => {
      await subscribe(h, 'payment_request:expired');
      sphere._emit('payment_request:updated', { id: 'gone', status: 'expired' });
      const frames = eventsOfType(h.pair.hostSent, 'payment_request:expired');
      expect(frames).toHaveLength(1);
      const data = frames[0].data as Record<string, unknown>;
      expect(data.id).toBe('gone');
      expect(data.status).toBe('expired');
      expect(data).toHaveProperty('senderPubkey');
      expect(data).toHaveProperty('amount');
      expect(data).toHaveProperty('coinId');
      expect(data).toHaveProperty('symbol');
      expect(data).toHaveProperty('requestId');
      expect(data).toHaveProperty('timestamp');
    });

    it('pending/settling updates fire none of the old per-status names', async () => {
      await subscribe(h, 'payment_request:paid');
      await subscribe(h, 'payment_request:rejected');
      await subscribe(h, 'payment_request:expired');
      sphere._emit('payment_request:updated', { id: REQUEST_VIEW.id, status: 'pending' });
      sphere._emit('payment_request:updated', { id: REQUEST_VIEW.id, status: 'settling' });
      expect(eventsOfType(h.pair.hostSent, 'payment_request:paid')).toHaveLength(0);
      expect(eventsOfType(h.pair.hostSent, 'payment_request:rejected')).toHaveLength(0);
      expect(eventsOfType(h.pair.hostSent, 'payment_request:expired')).toHaveLength(0);
    });
  });

  describe('payment_request:incoming → legacy IncomingPaymentRequest shape', () => {
    it('a v2 view without symbol reaches the subscriber with symbol \'\' and every legacy-required field', async () => {
      const received: unknown[] = [];
      await subscribe(h, 'payment_request:incoming', (d) => received.push(d));
      sphere._emit('payment_request:incoming', REQUEST_VIEW_NO_SYMBOL);
      const frames = eventsOfType(h.pair.hostSent, 'payment_request:incoming');
      expect(frames).toHaveLength(1);
      // The SAME mapping the paid/rejected/expired rebuilds use.
      expect(frames[0].data).toEqual({ ...REQUEST_VIEW_NO_SYMBOL, symbol: '' });
      const data = frames[0].data as Record<string, unknown>;
      for (const field of ['id', 'requestId', 'senderPubkey', 'amount', 'coinId', 'symbol', 'timestamp', 'status'] as const) {
        expect(data).toHaveProperty(field);
      }
      expect(typeof data.symbol).toBe('string');
      expect(received).toEqual([{ ...REQUEST_VIEW_NO_SYMBOL, symbol: '' }]);
    });

    it('a registry-resolved symbol passes through unchanged', async () => {
      await subscribe(h, 'payment_request:incoming');
      sphere._emit('payment_request:incoming', REQUEST_VIEW);
      const frames = eventsOfType(h.pair.hostSent, 'payment_request:incoming');
      expect(frames).toHaveLength(1);
      expect(frames[0].data).toEqual({ ...REQUEST_VIEW, symbol: 'UCT' });
    });
  });

  describe('transfer:attention → split:checkpoint-stuck / delivery:undeliverable / delivery:deferred', () => {
    it('re-emits split:checkpoint-stuck with the old {transferId, code, error} shape', async () => {
      await subscribe(h, 'split:checkpoint-stuck');
      sphere._emit('transfer:attention', {
        transferId: 'tr9', code: 'split:checkpoint-stuck', detail: 'SPLIT_CHECKPOINT_LOST',
      });
      const frames = eventsOfType(h.pair.hostSent, 'split:checkpoint-stuck');
      expect(frames).toHaveLength(1);
      expect(frames[0].data).toEqual({
        transferId: 'tr9', code: 'SPLIT_CHECKPOINT_LOST', error: 'SPLIT_CHECKPOINT_LOST',
      });
    });

    it('re-emits delivery:undeliverable with the old field set', async () => {
      await subscribe(h, 'delivery:undeliverable');
      sphere._emit('transfer:attention', {
        transferId: 'tr10', code: 'delivery:undeliverable', detail: 'op 0 after 5 attempts',
      });
      const frames = eventsOfType(h.pair.hostSent, 'delivery:undeliverable');
      expect(frames).toHaveLength(1);
      expect(frames[0].data).toEqual({
        transferId: 'tr10', recipientPubkey: '', attempts: 0, error: 'op 0 after 5 attempts',
      });
    });

    it('re-emits delivery:deferred with the old field set', async () => {
      await subscribe(h, 'delivery:deferred');
      sphere._emit('transfer:attention', { transferId: 'tr11', code: 'delivery:deferred' });
      const frames = eventsOfType(h.pair.hostSent, 'delivery:deferred');
      expect(frames).toHaveLength(1);
      expect(frames[0].data).toEqual({
        transferId: 'tr11', recipientPubkey: '', reason: 'delivery:deferred', deferredUntil: 0,
      });
    });

    it('a foreign attention code fires none of the three old names', async () => {
      await subscribe(h, 'split:checkpoint-stuck');
      await subscribe(h, 'delivery:undeliverable');
      await subscribe(h, 'delivery:deferred');
      sphere._emit('transfer:attention', { transferId: 'm1', code: 'mint:unresolved' });
      expect(eventsOfType(h.pair.hostSent, 'split:checkpoint-stuck')).toHaveLength(0);
      expect(eventsOfType(h.pair.hostSent, 'delivery:undeliverable')).toHaveLength(0);
      expect(eventsOfType(h.pair.hostSent, 'delivery:deferred')).toHaveLength(0);
    });
  });

  describe('connection:status → realtime:status / storage:degraded', () => {
    it.each([
      ['connected', 'connected'],
      ['degraded', 'reconnecting'],
      ['offline', 'closed'],
    ] as const)('maps connection:status %s → realtime:status %s', async (v2Status, oldStatus) => {
      await subscribe(h, 'realtime:status');
      sphere._emit('connection:status', { status: v2Status });
      const frames = eventsOfType(h.pair.hostSent, 'realtime:status');
      expect(frames).toHaveLength(1);
      expect(frames[0].data).toEqual({ status: oldStatus });
    });

    it('re-emits storage:degraded only on a degraded connection', async () => {
      await subscribe(h, 'storage:degraded');
      sphere._emit('connection:status', { status: 'connected' });
      sphere._emit('connection:status', { status: 'offline' });
      expect(eventsOfType(h.pair.hostSent, 'storage:degraded')).toHaveLength(0);
      sphere._emit('connection:status', { status: 'degraded' });
      const frames = eventsOfType(h.pair.hostSent, 'storage:degraded');
      expect(frames).toHaveLength(1);
      expect(frames[0].data).toEqual({
        providerId: 'wallet-api', error: 'wallet-api connection degraded',
      });
    });
  });

  describe('inventory:updated → sync:completed / sync:remote-update', () => {
    it('re-emits sync:completed with the old {source, count} shape (live token count)', async () => {
      await subscribe(h, 'sync:completed');
      sphere._emit('inventory:updated', {});
      const frames = eventsOfType(h.pair.hostSent, 'sync:completed');
      expect(frames).toHaveLength(1);
      expect(frames[0].data).toEqual({ source: 'payments', count: TOKENS.length });
    });

    it('re-emits sync:remote-update with the old field set and a monotone sequence', async () => {
      await subscribe(h, 'sync:remote-update');
      sphere._emit('inventory:updated', {});
      sphere._emit('inventory:updated', {});
      const frames = eventsOfType(h.pair.hostSent, 'sync:remote-update');
      expect(frames).toHaveLength(2);
      expect(frames[0].data).toEqual({
        providerId: 'wallet-api', name: 'wallet-api', sequence: 1, cid: '', added: 0, removed: 0,
      });
      expect((frames[1].data as { sequence: number }).sequence).toBe(2);
    });
  });

  describe('bookkeeping', () => {
    it('v2 event names pass through untouched (no adapter hijack)', async () => {
      await subscribe(h, 'transfer:updated');
      sphere._emit('transfer:updated', DELIVERED);
      const frames = eventsOfType(h.pair.hostSent, 'transfer:updated');
      expect(frames).toHaveLength(1);
      expect(frames[0].data).toEqual(DELIVERED);
    });

    it('sphere_unsubscribe detaches a compat subscription', async () => {
      const unsub = await subscribe(h, 'transfer:confirmed');
      unsub();
      await tick();
      sphere._emit('transfer:updated', DELIVERED);
      expect(eventsOfType(h.pair.hostSent, 'transfer:confirmed')).toHaveLength(0);
    });

    it('old names still pass through directly on a legacy host (adapter dormant)', async () => {
      const legacy = createLegacyMockSphere();
      const h2 = await connectHarness(legacy);
      await subscribe(h2, 'transfer:confirmed');
      (legacy as ReturnType<typeof createLegacyMockSphere>)._emit('transfer:confirmed', DELIVERED);
      const frames = eventsOfType(h2.pair.hostSent, 'transfer:confirmed');
      expect(frames).toHaveLength(1);
      expect(frames[0].data).toEqual(DELIVERED);
    });

    it('a compat subscription survives a lock/unlock cycle (suspended-key replay)', async () => {
      await subscribe(h, 'transfer:confirmed');
      // Wallet ordering contract: setLocked() BEFORE destroy.
      h.host.setLocked();
      sphere._destroy();
      const rebound = createV2MockSphere();
      h.host.updateSphere(rebound);
      await tick();
      rebound._emit('transfer:updated', DELIVERED);
      const frames = eventsOfType(h.pair.hostSent, 'transfer:confirmed');
      expect(frames).toHaveLength(1);
      expect(frames[0].data).toEqual(DELIVERED);
    });
  });
});
