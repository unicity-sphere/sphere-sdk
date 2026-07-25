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
