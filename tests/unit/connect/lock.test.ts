/**
 * Graceful wallet lock — ConnectHost/ConnectClient behaviour across a lock.
 *
 * Harness mirrors tests/unit/connect/integration.test.ts (same mock transport pair and
 * mock Sphere) with two additions the lock tests need: both directions of the wire are
 * RECORDED, and the mock Sphere can be "destroyed" the way Sphere.destroy() destroys a
 * real one (eventHandlers cleared, so every unsub closure the host holds is dead).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConnectHost } from '../../../connect/host/ConnectHost';
import { ConnectClient } from '../../../connect/client/ConnectClient';
import { ConnectError } from '../../../connect';
import { logger } from '../../../core/logger';
import type { ConnectTransport } from '../../../connect/types';
import type { SphereConnectMessage } from '../../../connect/protocol';
import { PERMISSION_SCOPES } from '../../../connect/permissions';
import {
  ERROR_CODES,
  RPC_METHODS,
  INTENT_ACTIONS,
  WALLET_EVENTS,
  SPHERE_CONNECT_NAMESPACE,
  SPHERE_CONNECT_VERSION,
} from '../../../connect/protocol';

// ===========================================================================
// Mock transport: connects two sides in-memory AND records both directions
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
// Mock Sphere
// ===========================================================================

function createMockSphere(overrides?: { chainPubkey?: string; networkId?: number }) {
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();

  return {
    identity: {
      chainPubkey: overrides?.chainPubkey ?? '02abc123',
      directAddress: 'DIRECT://test',
      nametag: 'alice',
    },
    networkId: overrides?.networkId ?? 4,
    payments: {
      getBalance: vi.fn().mockReturnValue([{ coinId: 'UCT', totalAmount: '1000000' }]),
      getAssets: vi.fn().mockResolvedValue([{ coinId: 'UCT', symbol: 'UCT', totalAmount: '1000000' }]),
      getFiatBalance: vi.fn().mockResolvedValue(10.5),
      getTokens: vi.fn().mockReturnValue([
        { id: 'tok1', coinId: 'UCT', amount: '1000000', sdkData: { internal: true } },
      ]),
      getHistory: vi.fn().mockReturnValue([]),
    },
    signMessage: vi.fn(),
    resolve: vi.fn().mockResolvedValue({ nametag: 'bob', chainPubkey: '03def456' }),
    on: vi.fn((type: string, handler: (data: unknown) => void) => {
      if (!eventHandlers.has(type)) eventHandlers.set(type, new Set());
      eventHandlers.get(type)!.add(handler);
      return () => eventHandlers.get(type)?.delete(handler);
    }),
    /** Test helper to emit events. */
    _emit(type: string, data: unknown) {
      for (const h of eventHandlers.get(type) ?? []) h(data);
    },
    /** Mirrors Sphere.destroy(): every handler dies with the instance, so the host's
     *  unsub closures become DEAD, not merely stale. */
    _destroy() { eventHandlers.clear(); },
    communications: undefined as unknown,
  };
}

// ===========================================================================
// Shared fixtures
// ===========================================================================

const DAPP = { name: 'Lock dApp', url: 'https://lock.app' };
const ORIGIN = 'https://lock.app';

interface Harness {
  pair: MockPair;
  sphere: ReturnType<typeof createMockSphere>;
  host: ConnectHost;
  client: ConnectClient;
  onLockedRequest: ReturnType<typeof vi.fn>;
  onIntent: ReturnType<typeof vi.fn>;
  onDisconnect: ReturnType<typeof vi.fn>;
  onConnectionRequest: ReturnType<typeof vi.fn>;
}

function makeHost(pair: MockPair, overrides: Record<string, unknown> = {}): ConnectHost {
  const base = {
    sphere: createMockSphere(),
    transport: pair.host,
    origin: ORIGIN,
    onConnectionRequest: vi.fn().mockResolvedValue({
      approved: true,
      grantedPermissions: Object.values(PERMISSION_SCOPES),
    }),
    onIntent: vi.fn().mockResolvedValue({ result: { success: true } }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ConnectHost({ ...base, ...overrides } as any);
}

/** A connected host+client pair, ready for a lock. */
async function connectHarness(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const pair = createMockTransportPair();
  const sphere = createMockSphere();
  const onLockedRequest = vi.fn();
  const onIntent = vi.fn().mockResolvedValue({ result: { success: true } });
  const onDisconnect = vi.fn();
  const onConnectionRequest = vi.fn().mockResolvedValue({
    approved: true,
    grantedPermissions: Object.values(PERMISSION_SCOPES),
  });

  const host = makeHost(pair, {
    sphere,
    onLockedRequest,
    onIntent,
    onDisconnect,
    onConnectionRequest,
    ...overrides,
  });

  const client = new ConnectClient({
    transport: pair.client,
    dapp: DAPP,
    network: { id: 4 },
  });
  await client.connect();

  return { pair, sphere, host, client, onLockedRequest, onIntent, onDisconnect, onConnectionRequest };
}

/** The wallet's ORDERING CONTRACT: setLocked() BEFORE sphere.destroy(). */
function lockWallet(h: Harness): void {
  h.host.setLocked();
  h.sphere._destroy();
}

function eventsOfType(sent: SphereConnectMessage[], event: string) {
  return sent.filter((m) => m.type === 'event' && (m as { event: string }).event === event);
}

function handshakeResponses(sent: SphereConnectMessage[]) {
  return sent.filter(
    (m) => m.type === 'handshake' && (m as { direction?: string }).direction === 'response',
  ) as Array<Record<string, unknown>>;
}

function subscribeCalls(sent: SphereConnectMessage[]): string[] {
  return sent
    .filter((m) => m.type === 'request' && (m as { method: string }).method === RPC_METHODS.SUBSCRIBE)
    .map((m) => ((m as { params?: { event?: string } }).params?.event ?? ''));
}

function sendRawHandshake(pair: MockPair, extra: Record<string, unknown> = {}): void {
  pair.client.send({
    ns: SPHERE_CONNECT_NAMESPACE,
    v: SPHERE_CONNECT_VERSION,
    type: 'handshake',
    direction: 'request',
    permissions: [],
    dapp: DAPP,
    network: { id: 4 },
    ...extra,
  } as unknown as SphereConnectMessage);
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ===========================================================================
// Task 6 — the two orthogonal axes
// ===========================================================================

describe('ConnectHost wallet-binding axis', () => {
  let pair: MockPair;

  beforeEach(() => {
    pair = createMockTransportPair();
  });

  it('defaults to live with a bound Sphere and no session', () => {
    const host = makeHost(pair);
    expect(host.walletState).toBe('live');
    expect(host.getSession()).toBeNull();
    expect(host.getState()).toEqual({ walletState: 'live', session: null });
  });

  it("starts locked when initialWalletState is 'locked' and sphere is null", () => {
    const host = makeHost(pair, { sphere: null, initialWalletState: 'locked' });
    expect(host.walletState).toBe('locked');
    // No prior binding ⇒ nothing may be served from the snapshot.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((host as any).snapshot.capturedAt).toBe(0);
  });

  it("coerces live + sphere: null to 'unavailable' with a warning instead of throwing", () => {
    const captured: string[] = [];
    logger.configure({ debug: true, handler: (_l, tag, message) => { captured.push(`${tag}:${message}`); } });
    try {
      // A throw here would break the wallet's React mount, so the host fails LOUD but soft.
      const host = makeHost(pair, { sphere: null });
      expect(host.walletState).toBe('unavailable');
      expect(captured.join('\n')).toMatch(/Constructed live with sphere === null/);
    } finally {
      logger.configure({ debug: false, handler: null });
    }
  });

  it('nulls the Sphere reference whenever the state is not live (invariant B)', () => {
    const host = makeHost(pair, { sphere: createMockSphere(), initialWalletState: 'locked' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((host as any).sphere).toBeNull();
  });

  it('keeps the two axes independent: a live host with no session, a session with no Sphere', async () => {
    const h = await connectHarness();
    expect(h.host.getState()).toEqual({ walletState: 'live', session: h.host.getSession() });
    expect(h.host.getSession()).not.toBeNull();
  });

  it('answers a handshake on a cold-start-locked host instead of dereferencing null', async () => {
    const host = makeHost(pair, { sphere: null, initialWalletState: 'locked' });
    const client = new ConnectClient({ transport: pair.client, dapp: DAPP, network: { id: 4 } });

    // Shape-agnostic on purpose: Task 13 changes the refusal SHAPE (it becomes today's
    // EMPTY refusal instead of INCOMPATIBLE_NETWORK), not the fact that one is sent.
    await expect(client.connect()).rejects.toBeDefined();
    expect(handshakeResponses(pair.hostSent)).toHaveLength(1);
    expect(host.walletState).toBe('locked');
  });

  it('never serves a query from a null Sphere as a raw TypeError', async () => {
    const h = await connectHarness();
    // Drop the reference by hand — the lock VERBS arrive in Task 7.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.host as any).sphere = null;

    for (const method of [RPC_METHODS.GET_BALANCE, RPC_METHODS.GET_TOKENS, RPC_METHODS.RESOLVE]) {
      const err = await h.client.query(method, { identifier: '@bob' }).catch((e: unknown) => e);
      expect(err, `method ${method}`).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).message, `method ${method}`).not.toMatch(/Cannot read propert/);
    }
  });

  it('still serves every query normally while the Sphere is bound', async () => {
    const h = await connectHarness();

    await expect(h.client.query(RPC_METHODS.GET_BALANCE))
      .resolves.toEqual([{ coinId: 'UCT', totalAmount: '1000000' }]);
    await expect(h.client.query(RPC_METHODS.GET_FIAT_BALANCE))
      .resolves.toEqual({ fiatBalance: 10.5 });
    // stripTokenSdkData still removes the internal field.
    await expect(h.client.query(RPC_METHODS.GET_TOKENS))
      .resolves.toEqual([{ id: 'tok1', coinId: 'UCT', amount: '1000000' }]);
    expect(h.sphere.payments.getBalance).toHaveBeenCalledTimes(1);
  });
});
