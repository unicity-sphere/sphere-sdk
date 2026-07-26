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

// ===========================================================================
// Task 7 — setLocked() / setUnavailable() / revokeSession()
// ===========================================================================

describe('ConnectHost.setLocked()', () => {
  it('preserves the session, its dapp and its permissions', async () => {
    const h = await connectHarness();
    const before = h.host.getSession()!;
    const beforePermissions = [...before.permissions];

    lockWallet(h);

    const after = h.host.getSession();
    expect(after).not.toBeNull();
    expect(after!.id).toBe(before.id);
    expect(after!.active).toBe(true);
    expect(after!.dapp).toEqual(DAPP);
    expect(after!.permissions).toEqual(beforePermissions);
    expect(h.host.walletState).toBe('locked');
    expect(h.host.getState()).toEqual({ walletState: 'locked', session: after });
  });

  it('pushes exactly one wallet:locked and is idempotent', async () => {
    const h = await connectHarness();

    h.host.setLocked();
    h.host.setLocked();
    h.host.setLocked();

    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.LOCKED)).toHaveLength(1);
    expect(h.host.walletState).toBe('locked');
  });

  it('pushes no wallet:locked when there is no active session', () => {
    const pair = createMockTransportPair();
    const host = makeHost(pair);

    host.setLocked();

    expect(eventsOfType(pair.hostSent, WALLET_EVENTS.LOCKED)).toHaveLength(0);
    expect(host.walletState).toBe('locked');
  });

  it('freezes the snapshot BEFORE dropping the Sphere reference', async () => {
    const h = await connectHarness();

    lockWallet(h);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const host = h.host as any;
    expect(host.sphere).toBeNull();
    expect(host.snapshot.identity).toEqual({
      chainPubkey: '02abc123', directAddress: 'DIRECT://test', nametag: 'alice',
    });
    expect(host.snapshot.networkId).toBe(4);
  });

  it('snapshots subscription KEYS before detaching, excluding identity:changed', async () => {
    const h = await connectHarness();
    const handler = vi.fn();
    h.client.on('transfer:incoming', handler);
    await tick();

    lockWallet(h);
    h.sphere._emit('transfer:incoming', { amount: '1' });
    await tick();

    expect(handler).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const suspended = (h.host as any).suspendedSubscriptions as Set<string>;
    expect(suspended.has('transfer:incoming')).toBe(true);
    // autoSubscribeIdentityChanged() re-arms this one itself.
    expect(suspended.has(WALLET_EVENTS.IDENTITY_CHANGED)).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((h.host as any).eventSubscriptions.size).toBe(0);
  });

  it('clears auto-approved intents so none can execute unattended after the unlock', async () => {
    const h = await connectHarness();
    h.host.setIntentAutoApprove(INTENT_ACTIONS.DM, vi.fn().mockResolvedValue({ result: { ok: true } }));

    lockWallet(h);

    // Today only revokeSession() clears these; under session-preserving semantics an
    // auto-approved intent would otherwise survive the lock.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((h.host as any).autoApprovedIntents.size).toBe(0);
  });

  it('answers a Sphere-backed query with 4009 and data.reason after the lock', async () => {
    const h = await connectHarness();
    lockWallet(h);

    const err = await h.client.query(RPC_METHODS.GET_BALANCE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(ERROR_CODES.WALLET_LOCKED);
    expect(h.sphere.payments.getBalance).not.toHaveBeenCalled();
  });
});

describe('ConnectHost.setUnavailable()', () => {
  it('revokes the session and pushes wallet:disconnected — not wallet:locked', async () => {
    const h = await connectHarness();

    h.host.setUnavailable();

    expect(h.host.walletState).toBe('unavailable');
    expect(h.host.getSession()).toBeNull();
    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.DISCONNECTED)).toHaveLength(1);
    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.LOCKED)).toHaveLength(0);
  });

  it('empties the snapshot — nothing may be served from a wallet that is simply gone', async () => {
    const h = await connectHarness();

    h.host.setUnavailable();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const snap = (h.host as any).snapshot;
    expect(snap.capturedAt).toBe(0);
    expect(snap.identity).toBeUndefined();
    expect(snap.networkId).toBeUndefined();
  });

  it('answers subsequent queries 4001, never 4009 — unlocking cannot cure it', async () => {
    const h = await connectHarness();
    h.host.setUnavailable();

    const err = await h.client.query(RPC_METHODS.GET_BALANCE).catch((e: unknown) => e);
    expect((err as ConnectError).code).toBe(ERROR_CODES.NOT_CONNECTED);
    expect((err as ConnectError).code).not.toBe(ERROR_CODES.WALLET_LOCKED);
  });

  it('is idempotent and pushes wallet:disconnected only once', async () => {
    const h = await connectHarness();

    h.host.setUnavailable();
    h.host.setUnavailable();

    expect(h.host.walletState).toBe('unavailable');
    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.DISCONNECTED)).toHaveLength(1);
  });

  it('pushes no wallet:unavailable — there is no such event', async () => {
    const h = await connectHarness();
    h.host.setUnavailable();
    const events = h.pair.hostSent
      .filter((m) => m.type === 'event')
      .map((m) => (m as { event: string }).event);
    expect(events).not.toContain('wallet:unavailable');
  });
});

describe('ConnectHost.revokeSession()', () => {
  it('pushes wallet:disconnected BEFORE tearing the session down', async () => {
    const h = await connectHarness();

    h.host.revokeSession();

    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.DISCONNECTED)).toHaveLength(1);
    expect(h.host.getSession()).toBeNull();
  });

  it('does NOT touch walletState — the two axes are orthogonal', async () => {
    const h = await connectHarness();
    lockWallet(h);

    h.host.revokeSession();

    expect(h.host.getSession()).toBeNull();
    expect(h.host.walletState).toBe('locked');
    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.DISCONNECTED)).toHaveLength(1);
  });

  it('pushes nothing when there was no session', () => {
    const pair = createMockTransportPair();
    const host = makeHost(pair);

    host.revokeSession();

    expect(eventsOfType(pair.hostSent, WALLET_EVENTS.DISCONNECTED)).toHaveLength(0);
    expect(host.walletState).toBe('live');
  });

  it('clears the suspended-subscription set so an unlock cannot resurrect a dead session', async () => {
    const h = await connectHarness();
    h.client.on('transfer:incoming', vi.fn());
    await tick();
    lockWallet(h);

    h.host.revokeSession();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((h.host as any).suspendedSubscriptions as Set<string>).size).toBe(0);
  });
});

describe('notifyWalletLocked() is REMOVED, not aliased', () => {
  it('does not exist on the prototype', () => {
    // Its old meaning was REVOKE; the new meaning would be LOCK — the opposite. An alias
    // is a silent runtime inversion at every existing wallet call site, so it is a
    // compile-time break instead.
    expect(
      (ConnectHost.prototype as unknown as Record<string, unknown>).notifyWalletLocked,
    ).toBeUndefined();
  });

  it('exposes the four replacement verbs', () => {
    const p = ConnectHost.prototype as unknown as Record<string, unknown>;
    expect(typeof p.setLocked).toBe('function');
    expect(typeof p.setUnavailable).toBe('function');
    expect(typeof p.updateSphere).toBe('function');
    expect(typeof p.revokeSession).toBe('function');
  });
});

describe('ConnectHost.destroy()', () => {
  it('revokes, pushes wallet:disconnected and lands in unavailable', async () => {
    const h = await connectHarness();

    h.host.destroy();

    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.DISCONNECTED)).toHaveLength(1);
    expect(h.host.getSession()).toBeNull();
    expect(h.host.walletState).toBe('unavailable');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((h.host as any).sphere).toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((h.host as any).snapshot.capturedAt).toBe(0);
  });

  it('is idempotent', async () => {
    const h = await connectHarness();
    h.host.destroy();
    h.host.destroy();
    expect(h.host.walletState).toBe('unavailable');
    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.DISCONNECTED)).toHaveLength(1);
  });
});

// ===========================================================================
// Task 8 — locked gate (query path) + allow-list + onLockedRequest
// ===========================================================================

describe('locked gate — queries', () => {
  it('answers an UNKNOWN method with 4009, not PERMISSION_DENIED 4002', async () => {
    const h = await connectHarness();
    lockWallet(h);

    const err = await h.client.query('sphere_notAMethod').catch((e: unknown) => e);
    // Without the gate, hasMethodPermission() returns false for anything unmapped and the
    // dApp is told "permission denied" for a wallet that is merely locked.
    expect((err as ConnectError).code).toBe(ERROR_CODES.WALLET_LOCKED);
  });

  it('answers a method the dApp was never granted with 4009, not 4002', async () => {
    const h = await connectHarness({
      onConnectionRequest: vi.fn().mockResolvedValue({
        approved: true,
        grantedPermissions: [PERMISSION_SCOPES.IDENTITY_READ],
      }),
    });
    lockWallet(h);

    const err = await h.client.query(RPC_METHODS.GET_INVOICES).catch((e: unknown) => e);
    expect((err as ConnectError).code).toBe(ERROR_CODES.WALLET_LOCKED);
  });

  it('carries data.reason on every 4009', async () => {
    const h = await connectHarness();
    lockWallet(h);

    const err = await h.client.query(RPC_METHODS.GET_BALANCE).catch((e: unknown) => e);
    expect((err as ConnectError).data).toEqual({ reason: 'locked' });
    // unlockSurface is DECLARED in the fail-fast release and always absent.
    expect((err as ConnectError).data).not.toHaveProperty('unlockSurface');
  });

  it('refuses balances, tokens, history and fiat balance — never data, never cache', async () => {
    const h = await connectHarness();
    lockWallet(h);

    for (const method of [
      RPC_METHODS.GET_BALANCE, RPC_METHODS.GET_ASSETS, RPC_METHODS.GET_FIAT_BALANCE,
      RPC_METHODS.GET_TOKENS, RPC_METHODS.GET_HISTORY,
    ]) {
      const err = await h.client.query(method).catch((e: unknown) => e);
      expect((err as ConnectError).code, `method ${method}`).toBe(ERROR_CODES.WALLET_LOCKED);
    }
    expect(h.sphere.payments.getBalance).not.toHaveBeenCalled();
    expect(h.sphere.payments.getTokens).not.toHaveBeenCalled();
    expect(h.sphere.payments.getHistory).not.toHaveBeenCalled();
  });

  it('answers SESSION_EXPIRED 4004 rather than 4009 for a session that expired while locked', async () => {
    const h = await connectHarness({ sessionTtlMs: 5 });
    lockWallet(h);
    await tick(20);

    const err = await h.client.query(RPC_METHODS.GET_BALANCE).catch((e: unknown) => e);
    // A dead session must NEVER be advertised as "retry after unlock".
    expect((err as ConnectError).code).toBe(ERROR_CODES.SESSION_EXPIRED);
    expect(h.host.getSession()).toBeNull();
    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.DISCONNECTED)).toHaveLength(1);
  });

  it('answers RATE_LIMITED 4006 rather than 4009 over the budget', async () => {
    const h = await connectHarness({ maxRequestsPerSecond: 3 });
    lockWallet(h);

    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const err = await h.client.query(RPC_METHODS.GET_BALANCE).catch((e: unknown) => e);
      codes.push((err as ConnectError).code);
    }
    // The limiter is what bounds onLockedRequest volume — no second anti-spam mechanism.
    expect(codes).toContain(ERROR_CODES.WALLET_LOCKED);
    expect(codes).toContain(ERROR_CODES.RATE_LIMITED);
  });

  it('serves sphere_getIdentity FROM THE SNAPSHOT while locked', async () => {
    const h = await connectHarness();
    lockWallet(h);

    // Those exact bytes were already handed to this origin in the handshake response.
    await expect(h.client.query(RPC_METHODS.GET_IDENTITY)).resolves.toEqual({
      chainPubkey: '02abc123', directAddress: 'DIRECT://test', nametag: 'alice',
    });
  });

  it('refuses sphere_getIdentity with 4009 when the snapshot has no identity', async () => {
    const pair = createMockTransportPair();
    const sphere = createMockSphere();
    const host = makeHost(pair, { sphere });
    const client = new ConnectClient({ transport: pair.client, dapp: DAPP, network: { id: 4 } });
    await client.connect();

    // A wallet whose identity was gone at lock time: the snapshot has none, so there is
    // nothing to serve — and `undefined` as a SUCCESS result reads to a dApp as
    // "the wallet has no identity".
    (sphere as unknown as { identity: unknown }).identity = null;
    host.setLocked();

    const err = await client.query(RPC_METHODS.GET_IDENTITY).catch((e: unknown) => e);
    expect((err as ConnectError).code).toBe(ERROR_CODES.WALLET_LOCKED);
  });

  it('lets sphere_unsubscribe through the gate while locked', async () => {
    const h = await connectHarness();
    lockWallet(h);

    await expect(
      h.client.query(RPC_METHODS.UNSUBSCRIBE, { event: 'transfer:incoming' }),
    ).resolves.toEqual({ unsubscribed: true, event: 'transfer:incoming' });
  });

  it('lets sphere_disconnect through and fires onDisconnect while locked', async () => {
    const h = await connectHarness();
    lockWallet(h);

    await expect(h.client.query(RPC_METHODS.DISCONNECT)).resolves.toEqual({ disconnected: true });
    await tick();

    // Without this, the client swallows the 4001 and calls cleanup() anyway, so the dApp
    // shows "disconnected" while onDisconnect — the only hook that revokes the persisted
    // origin approval — never fires, and the next silent autoConnect gets straight back in.
    expect(h.onDisconnect).toHaveBeenCalledTimes(1);
    expect(h.host.getSession()).toBeNull();
  });

  it('answers 4001, never 4009, when there is no session at all', async () => {
    const pair = createMockTransportPair();
    const host = makeHost(pair);
    host.setLocked();
    // No handshake ever happened: the lock must be unobservable to this origin.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (host as any).handleRpcRequest({
      ns: SPHERE_CONNECT_NAMESPACE, v: SPHERE_CONNECT_VERSION,
      type: 'request', id: 'x', method: RPC_METHODS.GET_IDENTITY,
    });
    const responses = pair.hostSent.filter((m) => m.type === 'response');
    expect((responses[0] as { error: { code: number } }).error.code)
      .toBe(ERROR_CODES.NOT_CONNECTED);
  });

  it("the 4009 message does not match the reference dApp's teardown regex", async () => {
    const h = await connectHarness();
    lockWallet(h);

    const err = await h.client.query(RPC_METHODS.GET_BALANCE).catch((e: unknown) => e);
    // A courtesy guard, not a wire contract — dApps discriminate on .code.
    expect((err as Error).message).not.toMatch(/not.connected|timeout|transport|closed|session/i);
  });
});

describe('onLockedRequest (notify-only)', () => {
  it('fires for a locked query with the wallet-supplied origin, kind and name', async () => {
    const h = await connectHarness();
    lockWallet(h);

    await h.client.query(RPC_METHODS.GET_BALANCE).catch(() => undefined);

    expect(h.onLockedRequest).toHaveBeenCalledWith({
      origin: ORIGIN,
      kind: 'query',
      name: RPC_METHODS.GET_BALANCE,
    });
  });

  it('never uses the dApp-claimed session.dapp.url as the origin', async () => {
    const h = await connectHarness({ origin: 'https://verified.example' });
    lockWallet(h);

    await h.client.query(RPC_METHODS.GET_BALANCE).catch(() => undefined);

    const ctx = h.onLockedRequest.mock.calls[0]?.[0] as { origin?: string } | undefined;
    expect(ctx?.origin).toBe('https://verified.example');
    expect(ctx?.origin).not.toBe(DAPP.url);
  });

  it('passes origin: undefined when the host was constructed without one', async () => {
    const pair = createMockTransportPair();
    const onLockedRequest = vi.fn();
    const host = makeHost(pair, { onLockedRequest, origin: undefined });
    const client = new ConnectClient({ transport: pair.client, dapp: DAPP, network: { id: 4 } });
    await client.connect();

    host.setLocked();
    await client.query(RPC_METHODS.GET_BALANCE).catch(() => undefined);

    // The wallet must say "a connected app" — never claim an origin it cannot verify.
    expect(onLockedRequest).toHaveBeenCalledWith({
      origin: undefined,
      kind: 'query',
      name: RPC_METHODS.GET_BALANCE,
    });
  });

  it('does NOT fire for an allow-listed method', async () => {
    const h = await connectHarness();
    lockWallet(h);

    await h.client.query(RPC_METHODS.GET_IDENTITY);
    await h.client.query(RPC_METHODS.UNSUBSCRIBE, { event: 'transfer:incoming' });

    expect(h.onLockedRequest).not.toHaveBeenCalled();
  });

  it('does NOT fire when the wallet is merely unavailable', async () => {
    const h = await connectHarness();
    h.host.setUnavailable();

    await h.client.query(RPC_METHODS.GET_BALANCE).catch(() => undefined);

    // 'unavailable' is not something the user can unlock — a badge would be a lie.
    expect(h.onLockedRequest).not.toHaveBeenCalled();
  });

  it('survives a throwing handler — the dApp still gets its 4009', async () => {
    const h = await connectHarness({
      onLockedRequest: vi.fn(() => { throw new Error('wallet UI blew up'); }),
    });
    lockWallet(h);

    const err = await h.client.query(RPC_METHODS.GET_BALANCE).catch((e: unknown) => e);
    expect((err as ConnectError).code).toBe(ERROR_CODES.WALLET_LOCKED);
  });
});

// ===========================================================================
// Task 9 — locked gate (intent path) + rate limits on all three entries
// ===========================================================================

describe('locked gate — intents', () => {
  it('answers every intent with 4009 and data.reason — no allow-list', async () => {
    const h = await connectHarness();
    lockWallet(h);

    for (const action of [INTENT_ACTIONS.SEND, INTENT_ACTIONS.DM, INTENT_ACTIONS.MINT, INTENT_ACTIONS.RECEIVE]) {
      const err = await h.client.intent(action, { to: '@bob', amount: '1', coinId: 'UCT' })
        .catch((e: unknown) => e);
      expect(err, action).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).code, action).toBe(ERROR_CODES.WALLET_LOCKED);
      expect((err as ConnectError).data, action).toEqual({ reason: 'locked' });
    }
    expect(h.onIntent).not.toHaveBeenCalled();
  });

  it('does not run an auto-approve handler while locked', async () => {
    const h = await connectHarness();
    const auto = vi.fn().mockResolvedValue({ result: { ok: true } });
    h.host.setIntentAutoApprove(INTENT_ACTIONS.DM, auto);
    lockWallet(h);

    const err = await h.client.intent(INTENT_ACTIONS.DM, { to: '@bob', message: 'hi' })
      .catch((e: unknown) => e);

    expect((err as ConnectError).code).toBe(ERROR_CODES.WALLET_LOCKED);
    expect(auto).not.toHaveBeenCalled();
  });

  it('fires onLockedRequest with kind: intent and the action name', async () => {
    const h = await connectHarness();
    lockWallet(h);

    await h.client.intent(INTENT_ACTIONS.SEND, { to: '@bob', amount: '1', coinId: 'UCT' })
      .catch(() => undefined);

    expect(h.onLockedRequest).toHaveBeenCalledWith({
      origin: ORIGIN,
      kind: 'intent',
      name: INTENT_ACTIONS.SEND,
    });
  });

  it('answers 4001 for an intent when the wallet is unavailable, and raises no badge', async () => {
    const h = await connectHarness();
    h.host.setUnavailable();

    const err = await h.client.intent(INTENT_ACTIONS.SEND, { to: '@bob', amount: '1', coinId: 'UCT' })
      .catch((e: unknown) => e);

    expect((err as ConnectError).code).toBe(ERROR_CODES.NOT_CONNECTED);
    expect(h.onLockedRequest).not.toHaveBeenCalled();
  });

  it('answers SESSION_EXPIRED 4004 rather than 4009 for an intent on an expired session', async () => {
    const h = await connectHarness({ sessionTtlMs: 5 });
    lockWallet(h);
    await tick(20);

    const err = await h.client.intent(INTENT_ACTIONS.SEND, { to: '@bob', amount: '1', coinId: 'UCT' })
      .catch((e: unknown) => e);
    expect((err as ConnectError).code).toBe(ERROR_CODES.SESSION_EXPIRED);
  });
});

describe('rate limiting on the intent and handshake paths', () => {
  it('rejects intents over the per-second budget', async () => {
    // The handshake itself consumes one unit of the budget.
    const h = await connectHarness({ maxRequestsPerSecond: 3 });

    await h.client.intent(INTENT_ACTIONS.SEND, { to: '@a', amount: '1', coinId: 'UCT' });
    await h.client.intent(INTENT_ACTIONS.SEND, { to: '@b', amount: '1', coinId: 'UCT' });

    const err = await h.client
      .intent(INTENT_ACTIONS.SEND, { to: '@c', amount: '1', coinId: 'UCT' })
      .catch((e: unknown) => e);
    // The money path was the unlimited one: checkRateLimit() was reachable only from
    // handleRpcRequest.
    expect((err as ConnectError).code).toBe(ERROR_CODES.RATE_LIMITED);
  });

  it('bounds the badge volume a locked origin can farm by looping intents', async () => {
    const h = await connectHarness({ maxRequestsPerSecond: 3 });
    lockWallet(h);

    for (let i = 0; i < 8; i++) {
      await h.client.intent(INTENT_ACTIONS.SEND, { to: '@bob', amount: '1', coinId: 'UCT' })
        .catch(() => undefined);
    }

    // Every request is still ANSWERED — a refusal is an answer.
    expect(h.pair.hostSent.filter((m) => m.type === 'intent_result')).toHaveLength(8);
    // But the badge is metered by the EXISTING limiter, because the gate sits after it.
    expect(h.onLockedRequest.mock.calls.length).toBeGreaterThan(0);
    expect(h.onLockedRequest.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('rate-limits the handshake path, which was entirely unmetered', async () => {
    const pair = createMockTransportPair();
    const onConnectionRequest = vi.fn().mockResolvedValue({ approved: true, grantedPermissions: [] });
    makeHost(pair, { maxRequestsPerSecond: 2, onConnectionRequest });

    for (let i = 0; i < 5; i++) sendRawHandshake(pair);
    await tick();

    // Every handshake is still ANSWERED (a refusal is an answer) — but the approval UI is
    // not opened five times by an unapproved origin.
    expect(handshakeResponses(pair.hostSent)).toHaveLength(5);
    expect(onConnectionRequest.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('the rate-limited handshake refusal reveals nothing', async () => {
    const pair = createMockTransportPair();
    makeHost(pair, { maxRequestsPerSecond: 1 });

    sendRawHandshake(pair);
    sendRawHandshake(pair);
    await tick();

    // Order is NOT positional: the refusal is sent synchronously, while an approved
    // handshake answers only after `await onConnectionRequest`, so the success can land
    // last. Identify the refusal by its shape instead.
    const responses = handshakeResponses(pair.hostSent);
    expect(responses).toHaveLength(2);
    const refusal = responses.find((r) => r.sessionId === undefined)!;
    expect(refusal).toBeDefined();
    expect(refusal.error).toBeUndefined();
    expect(refusal.identity).toBeUndefined();
  });
});

// ===========================================================================
// Task 10 — in-flight settlement and host deadlines
// ===========================================================================

describe('in-flight requests at lock time', () => {
  it('answers an in-flight query with 4009 instead of -32603 or undefined-as-success', async () => {
    const h = await connectHarness();
    // getAssets is the only async payments call — hold it open across the lock.
    let release!: (v: unknown[]) => void;
    h.sphere.payments.getAssets.mockReturnValue(new Promise((r) => { release = r; }));

    const pending = h.client.query(RPC_METHODS.GET_ASSETS).catch((e: unknown) => e);
    await tick();

    lockWallet(h);
    release([{ coinId: 'UCT' }]);

    const err = await pending;
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(ERROR_CODES.WALLET_LOCKED);
    expect((err as ConnectError).data).toEqual({ reason: 'locked' });
  });

  it('never sends a second frame for an id the lock already settled', async () => {
    const h = await connectHarness();
    let release!: (v: unknown[]) => void;
    h.sphere.payments.getAssets.mockReturnValue(new Promise((r) => { release = r; }));

    const pending = h.client.query(RPC_METHODS.GET_ASSETS).catch(() => undefined);
    await tick();

    lockWallet(h);
    release([{ coinId: 'UCT' }]);
    await pending;
    await tick();

    const ids = h.pair.hostSent
      .filter((m) => m.type === 'response')
      .map((m) => (m as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('answers a delegated intent that never resolves instead of hanging the dApp', async () => {
    const h = await connectHarness({ onIntent: vi.fn(() => new Promise(() => {})) });

    const pending = h.client
      .intent(INTENT_ACTIONS.SEND, { to: '@bob', amount: '1', coinId: 'UCT' })
      .catch((e: unknown) => e);
    await tick();

    lockWallet(h);

    const err = await pending;
    expect(err).toBeInstanceOf(ConnectError);
    // NOT WALLET_LOCKED, which this test used to assert. 4009's documented advice is "retry
    // after wallet:unlocked" — safe for a read, ruinous for a spend the wallet may already
    // have submitted. See the "intent outcome contract" block at the end of this file.
    expect((err as ConnectError).code).toBe(ERROR_CODES.INTENT_OUTCOME_UNKNOWN);
  });

  it('aborts ctx.signal when the lock settles a pending intent', async () => {
    let seen: AbortSignal | undefined;
    const h = await connectHarness({
      onIntent: vi.fn((_a: string, _p: unknown, _s: unknown, ctx?: { signal: AbortSignal }) => {
        seen = ctx?.signal;
        return new Promise(() => {});
      }),
    });

    const pending = h.client
      .intent(INTENT_ACTIONS.SEND, { to: '@bob', amount: '1', coinId: 'UCT' })
      .catch(() => undefined);
    await tick();

    expect(seen).toBeDefined();
    expect(seen!.aborted).toBe(false);
    lockWallet(h);
    await pending;

    // The wallet MUST dismiss its modal on abort; without this the host's own deadline
    // manufactures the double-submit it was added to prevent.
    expect(seen!.aborted).toBe(true);
  });

  it('hands onIntent an origin and an expiresAt in the future', async () => {
    let ctx: { origin?: string; expiresAt: number } | undefined;
    const h = await connectHarness({
      onIntent: vi.fn(async (_a: string, _p: unknown, _s: unknown, c?: { origin?: string; expiresAt: number }) => {
        ctx = c;
        return { result: { ok: true } };
      }),
      intentDeadlineMs: 90_000,
    });

    await h.client.intent(INTENT_ACTIONS.SEND, { to: '@bob', amount: '1', coinId: 'UCT' });

    expect(ctx?.origin).toBe(ORIGIN);
    expect(ctx!.expiresAt).toBeGreaterThan(Date.now());
    expect(ctx!.expiresAt).toBeLessThanOrEqual(Date.now() + 90_000);
  });

  it('settles in-flight work with 4001 on revokeSession()', async () => {
    const h = await connectHarness();
    let release!: (v: unknown[]) => void;
    h.sphere.payments.getAssets.mockReturnValue(new Promise((r) => { release = r; }));

    const pending = h.client.query(RPC_METHODS.GET_ASSETS).catch((e: unknown) => e);
    await tick();

    h.host.revokeSession();
    release([]);

    const err = await pending;
    expect((err as ConnectError).code).toBe(ERROR_CODES.NOT_CONNECTED);
  });

  it('settles in-flight work with 4001 on destroy()', async () => {
    const h = await connectHarness();
    let release!: (v: unknown[]) => void;
    h.sphere.payments.getAssets.mockReturnValue(new Promise((r) => { release = r; }));

    const pending = h.client.query(RPC_METHODS.GET_ASSETS).catch((e: unknown) => e);
    await tick();

    h.host.destroy();
    release([]);

    const err = await pending;
    expect((err as ConnectError).code).toBe(ERROR_CODES.NOT_CONNECTED);
  });

  it('leaves the registry empty after a normal request and a normal intent', async () => {
    const h = await connectHarness();
    await h.client.query(RPC_METHODS.GET_BALANCE);
    await h.client.intent(INTENT_ACTIONS.SEND, { to: '@bob', amount: '1', coinId: 'UCT' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((h.host as any).inFlight.size).toBe(0);
  });

  it('answers an intent whose onIntent THROWS instead of hanging forever', async () => {
    const h = await connectHarness({
      onIntent: vi.fn(async () => { throw new Error('wallet modal crashed'); }),
    });

    const err = await h.client
      .intent(INTENT_ACTIONS.SEND, { to: '@bob', amount: '1', coinId: 'UCT' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(ERROR_CODES.INTERNAL_ERROR);
    // A raw JS message must never cross the trust boundary.
    expect((err as ConnectError).message).toBe('Internal wallet error');
  });
});

describe('host deadlines', () => {
  it('answers an unanswered intent with OUTCOME UNKNOWN at its deadline, and aborts the signal', async () => {
    let seen: AbortSignal | undefined;
    const h = await connectHarness({
      intentDeadlineMs: 40,
      onIntent: vi.fn((_a: string, _p: unknown, _s: unknown, ctx?: { signal: AbortSignal }) => {
        seen = ctx?.signal;
        return new Promise(() => {});
      }),
    });

    const err = await h.client
      .intent(INTENT_ACTIONS.SEND, { to: '@bob', amount: '1', coinId: 'UCT' })
      .catch((e: unknown) => e);

    // This test used to assert INTENT_CANCELLED (4200). A host deadline means only that we
    // stopped waiting — the wallet may already have submitted the transfer, and abort() cannot
    // un-submit one. Asserting a cancel invites the dApp to re-offer a payment that went
    // through. The signal still fires, so a wallet that CAN still back out does.
    expect((err as ConnectError).code).toBe(ERROR_CODES.INTENT_OUTCOME_UNKNOWN);
    expect(seen!.aborted).toBe(true);
  });

  it('answers an unanswered query with a fixed INTERNAL_ERROR at its deadline', async () => {
    const h = await connectHarness({ requestDeadlineMs: 40 });
    h.sphere.payments.getAssets.mockReturnValue(new Promise(() => {}));

    const err = await h.client.query(RPC_METHODS.GET_ASSETS).catch((e: unknown) => e);

    expect((err as ConnectError).code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect((err as ConnectError).message).toBe('Internal wallet error');
  });

  it('refuses an unanswered connection approval with the empty refusal', async () => {
    const pair = createMockTransportPair();
    makeHost(pair, {
      handshakeDeadlineMs: 40,
      onConnectionRequest: vi.fn(() => new Promise(() => {})),
    });
    const client = new ConnectClient({ transport: pair.client, dapp: DAPP, network: { id: 4 } });

    // A handshake carries no id, so its deadline sends the EMPTY refusal.
    await expect(client.connect()).rejects.toThrow('Connection rejected by wallet');
    expect(handshakeResponses(pair.hostSent)).toHaveLength(1);
  });

  it('does not interfere with a prompt answered in time', async () => {
    const h = await connectHarness({
      intentDeadlineMs: 5_000,
      onIntent: vi.fn(() => new Promise((resolve) => {
        setTimeout(() => resolve({ result: { ok: true } }), 20);
      })),
    });

    await expect(
      h.client.intent(INTENT_ACTIONS.SEND, { to: '@bob', amount: '1', coinId: 'UCT' }),
    ).resolves.toEqual({ ok: true });
  });
});

// ===========================================================================
// Task 11 — every frame with an id is answered; no raw JS text leaks
// ===========================================================================

describe('unhandled failures still answer the dApp', () => {
  it('keeps forwarding our own SphereError message, with the code in data', async () => {
    const h = await connectHarness();

    const err = await h.client.query(RPC_METHODS.RESOLVE).catch((e: unknown) => e);

    // DX, not a leak: the dApp author needs to know which parameter is missing.
    expect((err as ConnectError).code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect((err as ConnectError).message).toBe('Missing required parameter: identifier');
    expect((err as ConnectError).data).toEqual({ reason: 'VALIDATION_ERROR' });
  });

  it('replaces a NON-SphereError message with a fixed string', async () => {
    const h = await connectHarness();
    h.sphere.payments.getAssets.mockRejectedValue(new TypeError('registry.internals is not a function'));

    const err = await h.client.query(RPC_METHODS.GET_ASSETS).catch((e: unknown) => e);

    expect((err as ConnectError).code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect((err as ConnectError).message).toBe('Internal wallet error');
    expect((err as ConnectError).message).not.toMatch(/registry\.internals/);
  });

  it('answers a handshake whose onConnectionRequest throws with the empty refusal', async () => {
    const pair = createMockTransportPair();
    makeHost(pair, {
      onConnectionRequest: vi.fn(async () => { throw new Error('approval UI crashed'); }),
    });
    const client = new ConnectClient({ transport: pair.client, dapp: DAPP, network: { id: 4 } });

    await expect(client.connect()).rejects.toThrow('Connection rejected by wallet');
    const responses = handshakeResponses(pair.hostSent);
    expect(responses).toHaveLength(1);
    // A failed handshake must reveal nothing at all.
    expect(responses[0].error).toBeUndefined();
    expect(responses[0].sessionId).toBeUndefined();
  });

  it('answers a malformed request frame that blows up before the router', async () => {
    const h = await connectHarness();
    // Force a throw from inside handleRpcRequest by poisoning the rate limiter.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h.host as any).checkRateLimit = () => { throw new Error('boom'); };

    const err = await h.client.query(RPC_METHODS.GET_BALANCE).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(ERROR_CODES.INTERNAL_ERROR);
    expect((err as ConnectError).message).toBe('Internal wallet error');
  });

  it('does not double-answer an id the inner catch already settled', async () => {
    const h = await connectHarness();
    h.sphere.payments.getAssets.mockRejectedValue(new Error('inner'));

    await h.client.query(RPC_METHODS.GET_ASSETS).catch(() => undefined);
    await tick();

    const ids = h.pair.hostSent
      .filter((m) => m.type === 'response')
      .map((m) => (m as { id: string }).id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ===========================================================================
// Task 12 — updateSphere() re-arm and the lock-edge identity guard
// ===========================================================================

describe('updateSphere() re-arm after a lock', () => {
  it('pushes wallet:unlocked carrying the CURRENT identity, on the same session', async () => {
    const h = await connectHarness();
    const sessionId = h.host.getSession()!.id;
    lockWallet(h);

    h.host.updateSphere(createMockSphere());

    const unlocked = eventsOfType(h.pair.hostSent, WALLET_EVENTS.UNLOCKED);
    expect(unlocked).toHaveLength(1);
    expect((unlocked[0] as { data: { identity?: { chainPubkey: string } } }).data.identity)
      .toEqual({ chainPubkey: '02abc123', directAddress: 'DIRECT://test', nametag: 'alice' });
    expect(h.host.walletState).toBe('live');
    expect(h.host.getSession()!.id).toBe(sessionId);
  });

  it('serves queries again immediately after the re-arm', async () => {
    const h = await connectHarness();
    lockWallet(h);

    h.host.updateSphere(createMockSphere());

    await expect(h.client.query(RPC_METHODS.GET_BALANCE))
      .resolves.toEqual([{ coinId: 'UCT', totalAmount: '1000000' }]);
  });

  it('restores every suspended sphere_subscribe stream BEFORE pushing wallet:unlocked', async () => {
    const h = await connectHarness();
    const handler = vi.fn();
    h.client.on('transfer:incoming', handler);
    await tick();

    lockWallet(h);
    const next = createMockSphere();
    h.host.updateSphere(next);

    // Re-arm BEFORE push: a dApp reacting synchronously to wallet:unlocked must not be
    // able to race its own event streams.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((h.host as any).eventSubscriptions as Map<string, unknown>).has('transfer:incoming')).toBe(true);

    next._emit('transfer:incoming', { amount: '500', coinId: 'UCT' });
    await tick();
    expect(handler).toHaveBeenCalledWith({ amount: '500', coinId: 'UCT' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((h.host as any).suspendedSubscriptions as Set<string>).size).toBe(0);
  });

  it('records a sphere_subscribe made WHILE locked and arms it on unlock', async () => {
    const h = await connectHarness();
    lockWallet(h);

    // ConnectClient.on() is fire-and-forget and never retries, so refusing this would kill
    // the event stream forever after one lock.
    await expect(h.client.query(RPC_METHODS.SUBSCRIBE, { event: 'transfer:confirmed' }))
      .resolves.toEqual({ subscribed: true, event: 'transfer:confirmed' });

    const handler = vi.fn();
    h.client.on('transfer:confirmed', handler);
    const next = createMockSphere();
    h.host.updateSphere(next);
    await tick();

    next._emit('transfer:confirmed', { id: 'tx1' });
    await tick();
    expect(handler).toHaveBeenCalledWith({ id: 'tx1' });
  });

  it('keeps streams alive across two lock/unlock cycles', async () => {
    const h = await connectHarness();
    const handler = vi.fn();
    h.client.on('transfer:incoming', handler);
    await tick();

    let current = h.sphere;
    for (let cycle = 0; cycle < 2; cycle++) {
      h.host.setLocked();
      current._destroy();
      current = createMockSphere();
      h.host.updateSphere(current);
      await tick();
      current._emit('transfer:incoming', { cycle });
      await tick();
    }

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, { cycle: 0 });
    expect(handler).toHaveBeenNthCalledWith(2, { cycle: 1 });
  });

  it('refreshes the snapshot so the next handshake reports the new network', async () => {
    const h = await connectHarness();
    lockWallet(h);

    h.host.updateSphere(createMockSphere({ networkId: 7 }));

    sendRawHandshake(h.pair, { network: { id: 7 } });
    await tick();

    const last = handshakeResponses(h.pair.hostSent).at(-1)!;
    expect((last.network as { id: number }).id).toBe(7);
  });

  it('REVOKES instead of unlocking when a different seed came back', async () => {
    const h = await connectHarness();
    lockWallet(h);

    // "Forgot password → restore from recovery phrase" installs a DIFFERENT seed behind an
    // origin-keyed approval. Never send the previous wallet's payment from a new wallet.
    h.host.updateSphere(createMockSphere({ chainPubkey: '02adifferentseed' }));

    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.UNLOCKED)).toHaveLength(0);
    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.DISCONNECTED)).toHaveLength(1);
    expect(h.host.getSession()).toBeNull();
    expect(h.host.walletState).toBe('live');
  });

  it('drops a session that expired while locked and pushes wallet:disconnected', async () => {
    const h = await connectHarness({ sessionTtlMs: 5 });
    lockWallet(h);
    await tick(20);

    h.host.updateSphere(createMockSphere());

    // wallet:unlocked into a dead session would make the dApp's next request answer 4004.
    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.DISCONNECTED)).toHaveLength(1);
    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.UNLOCKED)).toHaveLength(0);
    expect(h.host.getSession()).toBeNull();
  });

  it('re-arms silently when the locked host had no session', () => {
    const pair = createMockTransportPair();
    const host = makeHost(pair, { sphere: null, initialWalletState: 'locked' });

    host.updateSphere(createMockSphere());

    expect(host.walletState).toBe('live');
    expect(pair.hostSent.filter((m) => m.type === 'event')).toHaveLength(0);
  });

  it('recovers from unavailable without an identity check and without an event', async () => {
    const h = await connectHarness();
    h.host.setUnavailable();
    const before = h.pair.hostSent.filter((m) => m.type === 'event').length;

    // Nothing was bound to compare against, and the session is already null.
    h.host.updateSphere(createMockSphere({ chainPubkey: '02totallydifferent' }));

    expect(h.host.walletState).toBe('live');
    expect(h.pair.hostSent.filter((m) => m.type === 'event')).toHaveLength(before);
  });

  it('still pushes identity:changed on a live address switch (unchanged behaviour)', async () => {
    const h = await connectHarness();

    h.host.updateSphere(createMockSphere({ chainPubkey: '02switched' }));

    const changed = eventsOfType(h.pair.hostSent, WALLET_EVENTS.IDENTITY_CHANGED);
    expect(changed).toHaveLength(1);
    expect((changed[0] as { data: { chainPubkey: string } }).data.chainPubkey).toBe('02switched');
    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.UNLOCKED)).toHaveLength(0);
    expect(h.host.getSession()).not.toBeNull();
  });

  it('a legal address switch followed by lock/unlock does NOT revoke', async () => {
    const h = await connectHarness();

    h.host.updateSphere(createMockSphere({ chainPubkey: '02switched' }));  // legal switch
    h.host.setLocked();                                                    // freezes 02switched
    h.host.updateSphere(createMockSphere({ chainPubkey: '02switched' }));  // same seed back

    // This is exactly the false positive a handshake-time boundIdentity would produce.
    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.UNLOCKED)).toHaveLength(1);
    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.DISCONNECTED)).toHaveLength(0);
    expect(h.host.getSession()).not.toBeNull();
  });

  it('does not resurrect a stream the dApp unsubscribed while locked', async () => {
    const h = await connectHarness();
    const handler = vi.fn();
    h.client.on('transfer:incoming', handler);
    await tick();

    lockWallet(h);
    await h.client.query(RPC_METHODS.UNSUBSCRIBE, { event: 'transfer:incoming' });

    const next = createMockSphere();
    h.host.updateSphere(next);
    await tick();
    next._emit('transfer:incoming', { amount: '1' });
    await tick();

    expect(handler).not.toHaveBeenCalled();
  });

  it('settles anything in flight with 4001 when the unlock revokes', async () => {
    const h = await connectHarness();
    let release!: (v: unknown[]) => void;
    h.sphere.payments.getAssets.mockReturnValue(new Promise((r) => { release = r; }));
    const pending = h.client.query(RPC_METHODS.GET_ASSETS).catch((e: unknown) => e);
    await tick();

    h.host.setLocked();                 // settles the in-flight query with 4009
    const err = await pending;
    expect((err as ConnectError).code).toBe(ERROR_CODES.WALLET_LOCKED);
    release([]);

    h.host.updateSphere(createMockSphere({ chainPubkey: '02other' }));
    expect(h.host.getSession()).toBeNull();
  });
});

describe('sphere_subscribe refuses auto-pushed names', () => {
  it('refuses wallet:unlocked and the other three', async () => {
    const h = await connectHarness();

    for (const event of Object.values(WALLET_EVENTS)) {
      const err = await h.client.query(RPC_METHODS.SUBSCRIBE, { event }).catch((e: unknown) => e);
      // Sphere.on() accepts any string and would silently never emit, so the subscribe
      // would succeed and deliver nothing forever.
      expect(err, event).toBeInstanceOf(ConnectError);
      expect((err as ConnectError).message, event).toMatch(/pushed automatically/);
    }
  });

  it('still accepts a real Sphere event', async () => {
    const h = await connectHarness();
    await expect(h.client.query(RPC_METHODS.SUBSCRIBE, { event: 'transfer:incoming' }))
      .resolves.toEqual({ subscribed: true, event: 'transfer:incoming' });
  });
});

// ===========================================================================
// Task 13 — handshake while locked
// ===========================================================================

describe('handshake while locked', () => {
  it('a matching resume SUCCEEDS and the response carries locked: true', async () => {
    const h = await connectHarness();
    const sessionId = h.host.getSession()!.id;
    lockWallet(h);
    const before = handshakeResponses(h.pair.hostSent).length;

    sendRawHandshake(h.pair, { sessionId });
    await tick();

    const resp = handshakeResponses(h.pair.hostSent)[before];
    expect(resp.error).toBeUndefined();
    expect(resp.sessionId).toBe(sessionId);
    expect(resp.locked).toBe(true);
    expect(resp.identity).toEqual({
      chainPubkey: '02abc123', directAddress: 'DIRECT://test', nametag: 'alice',
    });
  });

  it('pushes wallet:locked immediately after a locked handshake response', async () => {
    const h = await connectHarness();
    const sessionId = h.host.getSession()!.id;
    lockWallet(h);
    const before = eventsOfType(h.pair.hostSent, WALLET_EVENTS.LOCKED).length;

    sendRawHandshake(h.pair, { sessionId });
    await tick();

    expect(eventsOfType(h.pair.hostSent, WALLET_EVENTS.LOCKED).length).toBe(before + 1);
  });

  it('a fresh ConnectClient resuming during a lock lands connected AND locked', async () => {
    const h = await connectHarness();
    const sessionId = h.host.getSession()!.id;
    lockWallet(h);

    const resumed = new ConnectClient({
      transport: h.pair.client, dapp: DAPP, network: { id: 4 }, resumeSessionId: sessionId,
    });
    const result = await resumed.connect();

    expect(result.sessionId).toBe(sessionId);
    expect(result.locked).toBe(true);
    expect(resumed.isConnected).toBe(true);
  });

  it('forces silent: true on every handshake while locked', async () => {
    const h = await connectHarness();
    lockWallet(h);
    h.onConnectionRequest.mockClear();

    // A NEW origin, no sessionId, and the dApp did NOT ask for silent.
    sendRawHandshake(h.pair);
    await tick();

    // The wallet's own `if (silent) return { approved: false }` branch is what refuses an
    // unapproved origin with no UI. Forcing the flag is the entire mechanism.
    expect(h.onConnectionRequest).toHaveBeenCalledTimes(1);
    expect(h.onConnectionRequest.mock.calls[0][2]).toBe(true);
  });

  it('mints a session from the snapshot for a previously approved origin', async () => {
    const h = await connectHarness();
    lockWallet(h);
    const before = handshakeResponses(h.pair.hostSent).length;
    // A wallet that has this origin in sphere_connected_sites approves even when silent.
    h.onConnectionRequest.mockResolvedValue({
      approved: true, grantedPermissions: [PERMISSION_SCOPES.IDENTITY_READ],
    });

    sendRawHandshake(h.pair);
    await tick();

    const resp = handshakeResponses(h.pair.hostSent)[before];
    expect(resp.sessionId).toBeTypeOf('string');
    expect(resp.locked).toBe(true);
    expect(resp.identity).toBeDefined();
    expect(h.host.getSession()).not.toBeNull();
    expect(h.host.walletState).toBe('locked');
  });

  it('gives an unapproved origin todays empty refusal — the lock stays unobservable', async () => {
    const h = await connectHarness();
    lockWallet(h);
    const before = handshakeResponses(h.pair.hostSent).length;
    h.onConnectionRequest.mockResolvedValue({ approved: false, grantedPermissions: [] });

    sendRawHandshake(h.pair, { sessionId: 'someone-elses-session' });
    await tick();

    const resp = handshakeResponses(h.pair.hostSent)[before];
    expect(resp.error).toBeUndefined();
    expect(resp.sessionId).toBeUndefined();
    expect(resp.identity).toBeUndefined();
    expect(resp.locked).toBeUndefined();
  });

  it('never leaks INCOMPATIBLE_NETWORK from a cold-start-locked host', async () => {
    const pair = createMockTransportPair();
    const onConnectionRequest = vi.fn().mockResolvedValue({ approved: true, grantedPermissions: [] });
    makeHost(pair, { sphere: null, initialWalletState: 'locked', onConnectionRequest });

    sendRawHandshake(pair);
    await tick();

    const responses = handshakeResponses(pair.hostSent);
    expect(responses).toHaveLength(1);
    // 4008 here would tell an unapproved origin that a wallet lives at this window AND
    // hand it walletNetwork { id: -1 }. Step 0 refuses BEFORE checkCompatibility.
    expect(responses[0].error).toBeUndefined();
    expect(onConnectionRequest).not.toHaveBeenCalled();
  });

  it('refuses even a matching resume when there is no snapshot at all', async () => {
    const pair = createMockTransportPair();
    const host = makeHost(pair, { sphere: null, initialWalletState: 'locked' });

    sendRawHandshake(pair, { sessionId: 'anything' });
    await tick();

    // "Never invent a fact about a wallet we have not seen."
    const resp = handshakeResponses(pair.hostSent)[0];
    expect(resp.sessionId).toBeUndefined();
    expect(resp.locked).toBeUndefined();
    expect(host.walletState).toBe('locked');
  });

  it('refuses a handshake while unavailable without dereferencing Sphere', async () => {
    const h = await connectHarness();
    h.host.setUnavailable();
    const before = handshakeResponses(h.pair.hostSent).length;

    sendRawHandshake(h.pair);
    await tick();

    const resp = handshakeResponses(h.pair.hostSent)[before];
    expect(resp.error).toBeUndefined();
    expect(resp.sessionId).toBeUndefined();
  });

  it('fires onLockedRequest with kind: handshake', async () => {
    const h = await connectHarness();
    const sessionId = h.host.getSession()!.id;
    lockWallet(h);
    h.onLockedRequest.mockClear();

    sendRawHandshake(h.pair, { sessionId });
    await tick();

    expect(h.onLockedRequest).toHaveBeenCalledWith({
      origin: ORIGIN, kind: 'handshake', name: 'handshake',
    });
  });

  it('never sets locked on a live handshake response', async () => {
    const h = await connectHarness();
    const resp = handshakeResponses(h.pair.hostSent)[0];
    expect(resp.locked).toBeUndefined();
  });

  it('completes a normal handshake once the wallet is unlocked', async () => {
    const pair = createMockTransportPair();
    const host = makeHost(pair, { sphere: null, initialWalletState: 'locked' });
    host.updateSphere(createMockSphere());

    const client = new ConnectClient({ transport: pair.client, dapp: DAPP, network: { id: 4 } });
    const result = await client.connect();

    expect(result.sessionId).toBeTypeOf('string');
    expect(result.locked).toBeUndefined();
    expect(host.walletState).toBe('live');
  });
});

// ===========================================================================
// Task 14 — lifecycle logging
// ===========================================================================

describe('lifecycle logging', () => {
  const captured: Array<{ level: string; tag: string; message: string }> = [];

  beforeEach(() => {
    captured.length = 0;
    logger.configure({
      debug: true,
      handler: (level, tag, message) => { captured.push({ level, tag, message }); },
    });
  });

  afterEach(() => {
    logger.configure({ debug: false, handler: null });
  });

  function messages(level?: string): string {
    return captured
      .filter((e) => e.tag === 'ConnectHost' && (!level || e.level === level))
      .map((e) => e.message)
      .join('\n');
  }

  it('logs the lock, the 4009 refusal, the unlock and the revoke', async () => {
    const h = await connectHarness();

    lockWallet(h);
    expect(messages()).toMatch(/Wallet locked/);

    await h.client.query(RPC_METHODS.GET_BALANCE).catch(() => undefined);
    expect(messages()).toMatch(/WALLET_LOCKED 4009/);

    h.host.updateSphere(createMockSphere());
    expect(messages()).toMatch(/Wallet unlocked/);

    h.host.revokeSession();
    expect(messages()).toMatch(/Session revoked/);
  });

  it('distinguishes unavailable from locked, at warn level', async () => {
    const h = await connectHarness();
    h.host.setUnavailable();
    expect(messages('warn')).toMatch(/Sphere unavailable/);
    expect(messages('warn')).not.toMatch(/Wallet locked/);
  });

  it('warns loudly when a different seed comes back behind the lock screen', async () => {
    const h = await connectHarness();
    lockWallet(h);

    h.host.updateSphere(createMockSphere({ chainPubkey: '02adifferentseed' }));

    expect(messages('warn')).toMatch(/Different wallet behind the lock screen/);
  });

  it('warns when a session expired while locked', async () => {
    const h = await connectHarness({ sessionTtlMs: 5 });
    lockWallet(h);
    await tick(20);

    h.host.updateSphere(createMockSphere());

    expect(messages('warn')).toMatch(/expired while locked/i);
  });

  it('warns when a host deadline answers on the wallet behalf', async () => {
    const h = await connectHarness({ requestDeadlineMs: 30 });
    h.sphere.payments.getAssets.mockReturnValue(new Promise(() => {}));

    await h.client.query(RPC_METHODS.GET_ASSETS).catch(() => undefined);

    expect(messages('warn')).toMatch(/Host deadline reached/);
  });

  it('records the origin, or "unverified" when none was supplied', async () => {
    const h = await connectHarness({ origin: undefined });
    lockWallet(h);
    expect(messages()).toMatch(/origin=unverified/);
  });
});

// ===========================================================================
// Task 15 — ConnectClient and the auto-pushed wallet events
// ===========================================================================

describe('ConnectClient.walletProtocol', () => {
  it('is null before a handshake', () => {
    const pair = createMockTransportPair();
    const client = new ConnectClient({ transport: pair.client, dapp: DAPP, network: { id: 4 } });
    expect(client.walletProtocol).toBeNull();
  });

  it("records this SDK's wallet as 2.1", async () => {
    const h = await connectHarness();
    expect(h.client.walletProtocol).toBe(SPHERE_CONNECT_VERSION);
    expect(h.client.walletProtocol).toBe('2.1');
  });

  it('records an OLD 2.0 wallet, so a dApp knows wallet:unlocked will never arrive', async () => {
    const pair = createMockTransportPair();
    const client = new ConnectClient({ transport: pair.client, dapp: DAPP, network: { id: 4 } });

    const connecting = client.connect();
    await tick(0);

    // A Connect 2.0 wallet: same MAJOR (so the gate lets it through), but it has no
    // wallet:unlocked, no wallet:disconnected and no session-preserving lock.
    pair.host.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: '2.0',
      type: 'handshake',
      direction: 'response',
      permissions: [PERMISSION_SCOPES.IDENTITY_READ],
      sessionId: 'old-wallet-session',
      identity: { chainPubkey: '02old' },
      network: { id: 4 },
    } as unknown as SphereConnectMessage);

    await connecting;
    expect(client.walletProtocol).toBe('2.0');
  });

  it('is cleared when the session goes away', async () => {
    const h = await connectHarness();
    expect(h.client.walletProtocol).toBe('2.1');

    await h.client.disconnect();

    expect(h.client.walletProtocol).toBeNull();
  });
});

describe('ConnectClient.walletLocked', () => {
  it('is false after a live handshake', async () => {
    const h = await connectHarness();
    expect(h.client.walletLocked).toBe(false);
  });

  it('is true after wallet:locked, and the client stays CONNECTED', async () => {
    const h = await connectHarness();

    lockWallet(h);
    await tick();

    expect(h.client.walletLocked).toBe(true);
    expect(h.client.isConnected).toBe(true);
    expect(h.client.session).not.toBeNull();
  });

  it('is false again after wallet:unlocked', async () => {
    const h = await connectHarness();
    lockWallet(h);
    await tick();

    h.host.updateSphere(createMockSphere());
    await tick();

    expect(h.client.walletLocked).toBe(false);
    expect(h.client.isConnected).toBe(true);
  });

  it('is surfaced on ConnectResult for a resume during a lock', async () => {
    const h = await connectHarness();
    const sessionId = h.host.getSession()!.id;
    lockWallet(h);

    const resumed = new ConnectClient({
      transport: h.pair.client, dapp: DAPP, network: { id: 4 }, resumeSessionId: sessionId,
    });
    const result = await resumed.connect();

    expect(result.locked).toBe(true);
    expect(resumed.walletLocked).toBe(true);
  });
});

describe('ConnectClient and the auto-pushed lifecycle events', () => {
  it('updates client state on wallet:unlocked BEFORE the handler runs', async () => {
    const h = await connectHarness();

    // The payload carries the CURRENT identity, which may differ from the one the dApp
    // connected with — reached by a LEGAL address switch while live, then a lock. It must
    // NOT be reached by a different seed appearing across the lock: that is the money-safety
    // case the lock-edge guard revokes instead of unlocking.
    h.host.updateSphere(createMockSphere({ chainPubkey: '02newaddress' }));
    lockWallet(h);
    await tick();

    const seen: Array<{ locked: boolean; chainPubkey?: string }> = [];
    h.client.on(WALLET_EVENTS.UNLOCKED, (payload) => {
      seen.push({
        locked: h.client.walletLocked,
        chainPubkey: (payload as { identity?: { chainPubkey: string } }).identity?.chainPubkey,
      });
    });

    h.host.updateSphere(createMockSphere({ chainPubkey: '02newaddress' }));
    await tick();

    expect(seen).toEqual([{ locked: false, chainPubkey: '02newaddress' }]);
    expect(h.client.walletIdentity?.chainPubkey).toBe('02newaddress');
  });

  it('clears its own state on wallet:disconnected, handler FIRST', async () => {
    const h = await connectHarness();
    const seen: Array<{ connected: boolean }> = [];
    h.client.on(WALLET_EVENTS.DISCONNECTED, () => {
      // isConnected is already false (step 1), but cleanup() has not run yet (step 3),
      // so the handler is still registered and still fires.
      seen.push({ connected: h.client.isConnected });
    });

    h.host.revokeSession();
    await tick();

    expect(seen).toEqual([{ connected: false }]);
    expect(h.client.isConnected).toBe(false);
    expect(h.client.session).toBeNull();
  });

  it('rejects pending requests with a TYPED error when the session goes away', async () => {
    const h = await connectHarness();
    h.sphere.payments.getAssets.mockReturnValue(new Promise(() => {}));
    const pending = h.client.query(RPC_METHODS.GET_ASSETS).catch((e: unknown) => e);
    await tick();

    // Silence the host's INBOUND so nothing can answer the id, then deliver the teardown
    // event by hand. Going through client.disconnect() would park on its own 30 s query
    // timer against a dead transport — that short-circuit is deferred with the retry queue.
    h.pair.host.destroy();
    h.pair.host.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: 'event',
      event: WALLET_EVENTS.DISCONNECTED,
      data: {},
    } as unknown as SphereConnectMessage);

    const err = await pending;
    // new Error('Disconnected') carried no .code, so a dApp could not discriminate it.
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(ERROR_CODES.NOT_CONNECTED);
  });

  it('never sends sphere_subscribe for an auto-pushed event', async () => {
    const h = await connectHarness();

    h.client.on(WALLET_EVENTS.LOCKED, vi.fn());
    h.client.on(WALLET_EVENTS.UNLOCKED, vi.fn());
    h.client.on(WALLET_EVENTS.DISCONNECTED, vi.fn());
    h.client.on(WALLET_EVENTS.IDENTITY_CHANGED, vi.fn());
    h.client.on('transfer:incoming', vi.fn());
    await tick();

    // Sphere.on() accepts any string and would silently never emit for these four; the
    // host also refuses them outright now, so sending one is a guaranteed error.
    expect(subscribeCalls(h.pair.clientSent)).toEqual(['transfer:incoming']);
  });

  it('never sends sphere_unsubscribe for an auto-pushed event either', async () => {
    const h = await connectHarness();
    const off = h.client.on(WALLET_EVENTS.LOCKED, vi.fn());
    await tick();

    off();
    await tick();

    const unsubs = h.pair.clientSent.filter(
      (m) => m.type === 'request' && (m as { method: string }).method === RPC_METHODS.UNSUBSCRIBE,
    );
    expect(unsubs).toHaveLength(0);
  });

  it('still delivers wallet:locked to a dApp that registered no other handler', async () => {
    const h = await connectHarness();
    const onLocked = vi.fn();
    h.client.on(WALLET_EVENTS.LOCKED, onLocked);

    lockWallet(h);
    await tick();

    expect(onLocked).toHaveBeenCalledTimes(1);
    expect(onLocked).toHaveBeenCalledWith({});
  });
});

// ===========================================================================
// The intent OUTCOME contract
// ===========================================================================

/**
 * A host may report an intent's RESULT, or that the outcome is UNKNOWN. It may never assert
 * that nothing happened for an intent it has already handed to the wallet.
 *
 * The wallet is the only party that knows whether it submitted the transfer. Once onIntent has
 * been called, every code the host could invent is a guess — and two of the guesses are
 * actively dangerous: INTENT_CANCELLED (4200) says the user declined, and WALLET_LOCKED (4009)
 * invites a retry after the unlock. Either one, sent for an intent the wallet had already
 * submitted, produces a paid-but-not-credited order and then a double spend on the retry.
 */
describe('intent outcome contract (money safety)', () => {
  it('answers a host-deadline expiry with OUTCOME UNKNOWN, never with a cancellation', async () => {
    let release: ((v: { result: unknown }) => void) | undefined;
    const h = await connectHarness({
      intentDeadlineMs: 20,
      // The wallet is mid-transfer: it has taken the intent and has not answered yet.
      onIntent: vi.fn(() => new Promise<{ result: unknown }>((res) => { release = res; })),
    });

    const failure = h.client.intent(INTENT_ACTIONS.SEND, { to: 'bob', amount: '1' }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 60));
    const err = (await failure) as ConnectError;

    expect(err.code).toBe(ERROR_CODES.INTENT_OUTCOME_UNKNOWN);
    expect(err.code).not.toBe(ERROR_CODES.INTENT_CANCELLED);

    // And the late real result must not produce a second, contradictory frame.
    const before = h.pair.hostSent.length;
    release?.({ result: { success: true } });
    await new Promise((r) => setTimeout(r, 20));
    const intentResults = h.pair.hostSent
      .slice(before)
      .filter((m) => m.type === 'intent_result');
    expect(intentResults).toHaveLength(0);
  });

  it('answers a delegated intent with OUTCOME UNKNOWN when the wallet LOCKS mid-flight', async () => {
    const h = await connectHarness({
      onIntent: vi.fn(() => new Promise<{ result: unknown }>(() => {})),
    });

    const failure = h.client.intent(INTENT_ACTIONS.SEND, { to: 'bob', amount: '1' }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 10));
    lockWallet(h);
    const err = (await failure) as ConnectError;

    // NOT 4009: "retry after wallet:unlocked" is safe advice for a read and ruinous for a spend.
    expect(err.code).toBe(ERROR_CODES.INTENT_OUTCOME_UNKNOWN);
    expect(err.code).not.toBe(ERROR_CODES.WALLET_LOCKED);
  });

  it('answers a delegated intent with OUTCOME UNKNOWN when the session is REVOKED mid-flight', async () => {
    const h = await connectHarness({
      onIntent: vi.fn(() => new Promise<{ result: unknown }>(() => {})),
    });

    const failure = h.client.intent(INTENT_ACTIONS.SEND, { to: 'bob', amount: '1' }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 10));
    h.host.revokeSession();
    const err = (await failure) as ConnectError;

    // NOT 4001 either — "not connected" reads as "your request never ran".
    expect(err.code).toBe(ERROR_CODES.INTENT_OUTCOME_UNKNOWN);
    expect(err.code).not.toBe(ERROR_CODES.NOT_CONNECTED);
  });

  it('still settles a QUERY with the lock code, which IS safe to retry', async () => {
    const h = await connectHarness({
      sphere: (() => {
        const s = createMockSphere();
        s.payments.getBalance = vi.fn(() => new Promise(() => {}));
        return s;
      })(),
    });

    const failure = h.client.query(RPC_METHODS.GET_BALANCE).catch((e) => e);
    await new Promise((r) => setTimeout(r, 10));
    lockWallet(h);
    const err = (await failure) as ConnectError;

    expect(err.code).toBe(ERROR_CODES.WALLET_LOCKED);
  });
});
