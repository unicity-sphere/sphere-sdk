/**
 * Integration test for the default `transitionToAudit` closure that
 * `PaymentsModule` wires into the spent-state rescan worker by default
 * (Issue #174 bootstrap follow-up).
 *
 * Covers the two layers:
 *
 *  1. **Direct invocation of `defaultSpentStateTransition`** — exercises
 *     the closure in isolation against a `PaymentsModule` whose private
 *     `tokens` map has been seeded. Happy path: token at `'confirmed'`
 *     gets removed (archived + tombstoned + map-deleted via
 *     `removeToken`). Edge cases: token already removed (no-op), token
 *     no longer at `'confirmed'` (no-op), `removeToken` throw is
 *     swallowed (worker contract requires `transitionToAudit` never to
 *     throw).
 *
 *  2. **Auto-install end-to-end** — calls `module.initialize()` with
 *     `features.spentStateRescan: true`, asserts the auto-installed
 *     worker is wired to the default closure (no setter override), then
 *     runs a scan cycle against a mocked `oracle.isSpent` returning
 *     `true` for the seeded token. After the cycle, the token MUST be
 *     gone from `module.tokens` (the default closure called
 *     `removeToken`), and the `transfer:off-record-spent` event MUST
 *     have fired.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PaymentsModule } from '../../../modules/payments/PaymentsModule';
import { SpentStateRescanWorker } from '../../../modules/payments/transfer/spent-state-rescan-worker';
import type { FullIdentity, SphereEventMap, SphereEventType, Token } from '../../../types';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider } from '../../../storage';
import type { TransportProvider } from '../../../transport';

// =============================================================================
// SDK / registry mocks — keep tests deterministic, avoid network/crypto.
// =============================================================================

vi.mock('../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));

// =============================================================================
// Fixtures
// =============================================================================

function makeIdentity(): FullIdentity {
  return {
    chainPubkey: '02' + 'a'.repeat(64),
    l1Address: 'alpha1test',
    directAddress: 'DIRECT://test',
    privateKey: 'a'.repeat(64),
  };
}

function makeStorage(): StorageProvider {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
    }),
    delete: vi.fn(async (k: string) => {
      store.delete(k);
    }),
    clear: vi.fn(async () => store.clear()),
    has: vi.fn(async (k: string) => store.has(k)),
    keys: vi.fn(async () => [...store.keys()]),
  } as unknown as StorageProvider;
}

function makeTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => undefined),
    onPaymentRequest: vi.fn().mockReturnValue(() => undefined),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => undefined),
    resolve: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    publishNametag: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

interface MockOracle {
  readonly provider: OracleProvider;
  readonly isSpent: ReturnType<typeof vi.fn>;
}

function makeOracle(): MockOracle {
  const isSpent = vi.fn();
  return {
    isSpent,
    provider: {
      validateToken: vi.fn().mockResolvedValue({ valid: true }),
      getStateTransitionClient: vi.fn().mockReturnValue(null),
      waitForProofSdk: vi.fn(),
      isSpent,
    } as unknown as OracleProvider,
  };
}

function makeToken(overrides: Partial<Token> = {}): Token {
  return {
    id: overrides.id ?? 'tok-1',
    coinId: overrides.coinId ?? 'UCT-coin',
    symbol: overrides.symbol ?? 'UCT',
    name: overrides.name ?? 'Unicity',
    decimals: overrides.decimals ?? 8,
    amount: overrides.amount ?? '1000',
    status: overrides.status ?? 'confirmed',
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    updatedAt: overrides.updatedAt ?? 1_700_000_000_000,
    sdkData: overrides.sdkData ?? JSON.stringify({
      genesis: {
        data: { tokenId: 'tok-genesis-id' },
        inclusionProof: { authenticator: { stateHash: 'deadbeef' } },
      },
      transactions: [],
    }),
    ...overrides,
  };
}

interface RecordedEvent {
  readonly type: SphereEventType;
  readonly data: unknown;
}

function makeEventRecorder(): {
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  readonly events: ReadonlyArray<RecordedEvent>;
} {
  const events: RecordedEvent[] = [];
  return {
    events,
    emit: <T extends SphereEventType>(type: T, data: SphereEventMap[T]): void => {
      events.push({ type, data });
    },
  };
}

// =============================================================================
// Helper — invoke the private defaultSpentStateTransition method on the
// module. Casts through `unknown` so the call site has no leaking `any`.
// =============================================================================

type PrivateDefaultSpentStateTransitionFn = (params: {
  readonly token: Token;
  readonly currentStateHash: string;
  readonly suspectedSiblingInstance: boolean;
  readonly detectedAt: number;
}) => Promise<void>;

function invokeDefaultClosure(
  module: PaymentsModule,
  params: Parameters<PrivateDefaultSpentStateTransitionFn>[0],
): Promise<void> {
  const fn = (
    module as unknown as {
      defaultSpentStateTransition: PrivateDefaultSpentStateTransitionFn;
    }
  ).defaultSpentStateTransition.bind(module);
  return fn(params);
}

function getTokensMap(module: PaymentsModule): Map<string, Token> {
  return (module as unknown as { tokens: Map<string, Token> }).tokens;
}

function getInstalledWorker(module: PaymentsModule): SpentStateRescanWorker | null {
  return (module as unknown as { spentStateRescanWorker: SpentStateRescanWorker | null })
    .spentStateRescanWorker;
}

// =============================================================================
// Tests — direct invocation of the default closure
// =============================================================================

describe('PaymentsModule.defaultSpentStateTransition (Issue #174 bootstrap follow-up)', () => {
  let module: PaymentsModule;

  beforeEach(() => {
    module = new PaymentsModule({
      features: { spentStateRescan: false }, // we test the method, not auto-install
    });
    // Inject minimal deps so `ensureInitialized` (called by removeToken)
    // passes without standing up the full dependency graph.
    (module as unknown as { deps: unknown }).deps = {
      transport: makeTransport(),
      emitEvent: vi.fn(),
      identity: makeIdentity(),
    };
    // `save()` is private and writes to storage; stub it to a no-op so
    // we don't need a real storage provider. The closure's contract is
    // that `removeToken` returns successfully; `save()`-throw paths are
    // exercised in PaymentsModule's own removeToken tests.
    (module as unknown as { save: () => Promise<void> }).save = vi
      .fn()
      .mockResolvedValue(undefined);
    // archiveToken is private + invoked by removeToken; stub for the
    // same reason (we don't want to depend on the archive store wiring).
    (module as unknown as { archiveToken: (t: Token) => Promise<void> }).archiveToken = vi
      .fn()
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('removes a confirmed token via removeToken (archive + tombstone + map delete)', async () => {
    const token = makeToken({ id: 'tok-spent', status: 'confirmed' });
    getTokensMap(module).set(token.id, token);

    expect(getTokensMap(module).has(token.id)).toBe(true);

    await invokeDefaultClosure(module, {
      token,
      currentStateHash: 'state-tok-spent',
      suspectedSiblingInstance: true,
      detectedAt: 1_700_000_000_000,
    });

    // Token is gone from the active map.
    expect(getTokensMap(module).has(token.id)).toBe(false);

    // Tombstone was created (the (tokenId, stateHash) pair).
    const tombstones = module.getTombstones();
    expect(tombstones.length).toBeGreaterThan(0);
  });

  it('no-ops when the token is already gone from the active map (concurrent removal)', async () => {
    const token = makeToken({ id: 'tok-gone' });
    // Token NOT seeded into module.tokens — simulates the case where a
    // concurrent send / removeToken already cleared it.

    await expect(
      invokeDefaultClosure(module, {
        token,
        currentStateHash: 'state-tok-gone',
        suspectedSiblingInstance: false,
        detectedAt: 1_700_000_000_000,
      }),
    ).resolves.toBeUndefined();

    // archiveToken should NOT have been invoked — the no-op path
    // returns before calling removeToken.
    const archiveToken = (
      module as unknown as { archiveToken: ReturnType<typeof vi.fn> }
    ).archiveToken;
    expect(archiveToken).not.toHaveBeenCalled();
  });

  it('no-ops when the token status drifted from confirmed (race with send pipeline)', async () => {
    const token = makeToken({ id: 'tok-transferring' });
    const live = { ...token, status: 'transferring' as const };
    getTokensMap(module).set(live.id, live);

    await invokeDefaultClosure(module, {
      token,
      currentStateHash: 'state-tok-transferring',
      suspectedSiblingInstance: false,
      detectedAt: 1_700_000_000_000,
    });

    // Token stays in the map (the send pipeline owns this state).
    expect(getTokensMap(module).has(live.id)).toBe(true);
    expect(getTokensMap(module).get(live.id)!.status).toBe('transferring');
  });

  it('swallows a removeToken throw (worker contract requires no rethrow)', async () => {
    const token = makeToken({ id: 'tok-throw' });
    getTokensMap(module).set(token.id, token);

    // Replace the prototype `removeToken` so the unbound default closure
    // (bound at instance construction by the closure factory) hits a
    // throwing implementation.
    const moduleWithRemove = module as unknown as {
      removeToken: (id: string) => Promise<void>;
    };
    moduleWithRemove.removeToken = vi
      .fn()
      .mockRejectedValue(new Error('save failed'));

    await expect(
      invokeDefaultClosure(module, {
        token,
        currentStateHash: 'state-tok-throw',
        suspectedSiblingInstance: true,
        detectedAt: 1_700_000_000_000,
      }),
    ).resolves.toBeUndefined(); // critical: no rethrow
  });
});

// =============================================================================
// Tests — end-to-end auto-install via initialize() + scan cycle
// =============================================================================

describe('PaymentsModule auto-install wires the default closure (Issue #174 bootstrap follow-up)', () => {
  let module: PaymentsModule;
  let oracle: MockOracle;
  let recorder: ReturnType<typeof makeEventRecorder>;

  beforeEach(() => {
    oracle = makeOracle();
    recorder = makeEventRecorder();
    module = new PaymentsModule({
      features: { spentStateRescan: true, recipientUxf: false },
    });
    // `save()` and `archiveToken` are private and would otherwise need
    // a real storage backend to succeed. The auto-install path itself
    // does not invoke them; they fire only when the worker's
    // default closure calls `removeToken`, which we DO want to exercise
    // end-to-end. Stub both to no-ops so the integration runs
    // deterministically without standing up storage.
    (module as unknown as { save: () => Promise<void> }).save = vi
      .fn()
      .mockResolvedValue(undefined);
    (module as unknown as { archiveToken: (t: Token) => Promise<void> }).archiveToken = vi
      .fn()
      .mockResolvedValue(undefined);
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: oracle.provider,
      emitEvent: recorder.emit,
    });
  });

  afterEach(async () => {
    await module.destroy();
    vi.clearAllMocks();
  });

  it('initialize() auto-installs a SpentStateRescanWorker when the flag is ON', () => {
    const worker = getInstalledWorker(module);
    expect(worker).not.toBeNull();
    expect(worker).toBeInstanceOf(SpentStateRescanWorker);
    expect(worker!.isRunning()).toBe(true);
  });

  it('runScanCycle with isSpent=true triggers the default closure → token leaves the active map', async () => {
    const token = makeToken({ id: 'tok-e2e', amount: '5000' });
    getTokensMap(module).set(token.id, token);
    oracle.isSpent.mockResolvedValue(true);

    expect(getTokensMap(module).has(token.id)).toBe(true);

    const worker = getInstalledWorker(module)!;
    const result = await worker.runScanCycle();

    expect(result.spent).toBe(1);
    expect(result.unspent).toBe(0);
    // Token removed via the default closure.
    expect(getTokensMap(module).has(token.id)).toBe(false);
    // Tombstone was created.
    expect(module.getTombstones().length).toBeGreaterThan(0);

    // Event fired with the expected payload shape.
    const fired = recorder.events.filter(
      (e) => e.type === 'transfer:off-record-spent',
    );
    expect(fired).toHaveLength(1);
    const data = fired[0].data as {
      tokenId: string;
      coinId: string;
      amount: string;
      suspectedSiblingInstance: boolean;
    };
    expect(data.tokenId).toBe('tok-e2e');
    expect(data.coinId).toBe('UCT-coin');
    expect(data.amount).toBe('5000');
    // Neither OUTBOX nor SENT seeded → conservative true.
    expect(data.suspectedSiblingInstance).toBe(true);
  });

  it('runScanCycle with isSpent=false leaves the token untouched', async () => {
    const token = makeToken({ id: 'tok-unspent' });
    getTokensMap(module).set(token.id, token);
    oracle.isSpent.mockResolvedValue(false);

    const worker = getInstalledWorker(module)!;
    const result = await worker.runScanCycle();

    expect(result.spent).toBe(0);
    expect(result.unspent).toBe(1);
    // Token survives.
    expect(getTokensMap(module).has(token.id)).toBe(true);
    expect(
      recorder.events.filter((e) => e.type === 'transfer:off-record-spent'),
    ).toHaveLength(0);
  });

  it('setSpentStateRescanTransitionToAudit override replaces the default', async () => {
    // Override BEFORE initialize would be the usual pattern, but the
    // setter also works post-initialize when an explicit
    // installSpentStateRescanWorker call re-installs a worker. For this
    // test we stop the existing worker, set the override, and reinstall
    // a fresh worker that picks up the override.
    await module.destroy();

    const overrideCalls: Array<{ tokenId: string }> = [];
    module = new PaymentsModule({
      features: { spentStateRescan: true, recipientUxf: false },
    });
    (module as unknown as { save: () => Promise<void> }).save = vi
      .fn()
      .mockResolvedValue(undefined);
    (module as unknown as { archiveToken: (t: Token) => Promise<void> }).archiveToken = vi
      .fn()
      .mockResolvedValue(undefined);
    module.setSpentStateRescanTransitionToAudit(async (params) => {
      overrideCalls.push({ tokenId: params.token.id });
      // Override deliberately does NOT call removeToken — the token
      // should remain in the active map.
    });
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: oracle.provider,
      emitEvent: recorder.emit,
    });

    const token = makeToken({ id: 'tok-override' });
    getTokensMap(module).set(token.id, token);
    oracle.isSpent.mockResolvedValue(true);

    const worker = getInstalledWorker(module)!;
    await worker.runScanCycle();

    // Override fired; default did NOT (token still in map).
    expect(overrideCalls).toHaveLength(1);
    expect(overrideCalls[0].tokenId).toBe('tok-override');
    expect(getTokensMap(module).has(token.id)).toBe(true);
  });
});
