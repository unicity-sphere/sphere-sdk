/**
 * Issue #280 Layer 2 — recovery-time aggregator-spent sweep.
 *
 * Validates that `PaymentsModule.load()` triggers an immediate
 * `SpentStateRescanWorker.runScanCycle()` call when both
 * `features.recoveryAggregatorCheck` and `features.spentStateRescan`
 * are enabled. This is the defense-in-depth that fires regardless of
 * whether the local SENT/OUTBOX records are intact — typical of
 * cross-device IPFS-only recovery where the recovering peer has no
 * local SENT history yet.
 *
 * **Why this lives in `integration/`:** the test wires real
 * `PaymentsModule.initialize()` + `load()` paths against mocked
 * provider boundaries (oracle, storage, transport) so the load-time
 * hook is exercised through the production code path.
 *
 * Coverage:
 *
 *   1. Sweep IS triggered on load when both flags are ON and the
 *      worker is installed. Mock oracle returns `isSpent: true` for
 *      the seeded token → the token leaves the active pool (via the
 *      default `transitionToAudit` closure) AND the
 *      `transfer:off-record-spent` event fires.
 *   2. Sweep IS NOT triggered when `recoveryAggregatorCheck === false`
 *      (operator opt-out). The seeded token survives even though
 *      `oracle.isSpent` would return `true`.
 *   3. Sweep IS NOT triggered when `spentStateRescan === false`
 *      (worker not installed). Same: token survives.
 *   4. Sweep failure is logged at warn level but does NOT break
 *      `load()` (matches the orphan-sweep contract).
 *
 * @see profile/oplog-envelope-io.ts — Layer 1 (envelope decode fallback)
 * @see modules/payments/transfer/spent-state-rescan-worker.ts
 * @see modules/payments/PaymentsModule.ts (load() hook)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PaymentsModule } from '../../../modules/payments/PaymentsModule';
import { SpentStateRescanWorker } from '../../../modules/payments/transfer/spent-state-rescan-worker';
import type {
  FullIdentity,
  SphereEventMap,
  SphereEventType,
  Token,
} from '../../../types';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider } from '../../../storage';
import type { TransportProvider } from '../../../transport';

// =============================================================================
// SDK / registry mocks — same shape as spent-state-rescan-default-closure.test.ts
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
    id: overrides.id ?? 'tok-recovery-1',
    coinId: overrides.coinId ?? 'UCT-coin',
    symbol: overrides.symbol ?? 'UCT',
    name: overrides.name ?? 'Unicity',
    decimals: overrides.decimals ?? 8,
    amount: overrides.amount ?? '100000000000000000000',
    status: overrides.status ?? 'confirmed',
    createdAt: overrides.createdAt ?? 1_700_000_000_000,
    updatedAt: overrides.updatedAt ?? 1_700_000_000_000,
    sdkData:
      overrides.sdkData ??
      JSON.stringify({
        genesis: {
          data: { tokenId: 'tok-recovery-genesis' },
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
// Test helpers — reach into private state in a typed way.
// =============================================================================

function getTokensMap(module: PaymentsModule): Map<string, Token> {
  return (module as unknown as { tokens: Map<string, Token> }).tokens;
}

function getInstalledWorker(
  module: PaymentsModule,
): SpentStateRescanWorker | null {
  return (
    module as unknown as { spentStateRescanWorker: SpentStateRescanWorker | null }
  ).spentStateRescanWorker;
}

/**
 * Build a fully-initialized PaymentsModule with the given feature flags
 * and a seeded token. The token is placed into the in-memory active pool
 * via the private `tokens` map (the integration is too heavy to set up a
 * real storage provider that survives `load()`).
 */
async function buildModule(opts: {
  readonly recoveryAggregatorCheck: boolean;
  readonly spentStateRescan: boolean;
  readonly oracleIsSpent: boolean;
  readonly seedToken: Token;
}): Promise<{
  readonly module: PaymentsModule;
  readonly oracle: MockOracle;
  readonly recorder: ReturnType<typeof makeEventRecorder>;
}> {
  const oracle = makeOracle();
  oracle.isSpent.mockResolvedValue(opts.oracleIsSpent);
  const recorder = makeEventRecorder();
  const module = new PaymentsModule({
    features: {
      recoveryAggregatorCheck: opts.recoveryAggregatorCheck,
      spentStateRescan: opts.spentStateRescan,
      recipientUxf: false,
      // Suppress workers that would touch storage we don't fully stand up.
      finalizationWorker: false,
      nostrPersistenceVerifier: false,
      sentReconciliationWorker: false,
      tombstoneGcWorker: false,
      sendingRecoveryWorker: false,
      orphanAutoRecovery: false,
      legacyShapeMirror: false,
    },
  });
  // Stub storage-touching internals so removeToken / save runs as a no-op.
  (module as unknown as { save: () => Promise<void> }).save = vi
    .fn()
    .mockResolvedValue(undefined);
  (module as unknown as { archiveToken: (t: Token) => Promise<void> }).archiveToken =
    vi.fn().mockResolvedValue(undefined);
  // Stub load-time helpers that would otherwise hit real storage.
  (module as unknown as {
    loadPendingV5Tokens: () => Promise<void>;
  }).loadPendingV5Tokens = vi.fn().mockResolvedValue(undefined);
  (module as unknown as {
    primeProxyAddressCache: () => Promise<void>;
  }).primeProxyAddressCache = vi.fn().mockResolvedValue(undefined);
  (module as unknown as {
    restoreProofPollingJobs: () => Promise<void>;
  }).restoreProofPollingJobs = vi.fn().mockResolvedValue(undefined);
  (module as unknown as {
    recoverStrandedReceivedTokens: () => Promise<number>;
  }).recoverStrandedReceivedTokens = vi.fn().mockResolvedValue(0);
  (module as unknown as {
    loadProcessedSplitGroupIds: () => Promise<void>;
  }).loadProcessedSplitGroupIds = vi.fn().mockResolvedValue(undefined);
  (module as unknown as {
    loadProcessedCombinedTransferIds: () => Promise<void>;
  }).loadProcessedCombinedTransferIds = vi.fn().mockResolvedValue(undefined);
  (module as unknown as { loadHistory: () => Promise<void> }).loadHistory = vi
    .fn()
    .mockResolvedValue(undefined);
  (module as unknown as {
    rebuildParsedTokenCache: () => Promise<void>;
  }).rebuildParsedTokenCache = vi.fn().mockResolvedValue(undefined);
  (module as unknown as {
    createSigningService: () => Promise<unknown>;
  }).createSigningService = vi.fn().mockResolvedValue(null);
  (module as unknown as {
    getTokenStorageProviders: () => Map<string, unknown>;
  }).getTokenStorageProviders = vi.fn().mockReturnValue(new Map());

  module.initialize({
    identity: makeIdentity(),
    storage: makeStorage(),
    transport: makeTransport(),
    oracle: oracle.provider,
    emitEvent: recorder.emit,
  });
  // Seed the token into the in-memory active pool AFTER initialize so
  // the worker can see it on its first scan.
  getTokensMap(module).set(opts.seedToken.id, opts.seedToken);
  return { module, oracle, recorder };
}

// =============================================================================
// Tests
// =============================================================================

describe('Issue #280 Layer 2 — recovery-time aggregator-spent sweep', () => {
  let mod: PaymentsModule | null = null;

  afterEach(async () => {
    if (mod !== null) {
      await mod.destroy();
      mod = null;
    }
    vi.clearAllMocks();
  });

  it('triggers an immediate scan on load when both flags are ON; spent token leaves the pool', async () => {
    const token = makeToken({ id: 'tok-recovery-spent' });
    const { module, oracle, recorder } = await buildModule({
      recoveryAggregatorCheck: true,
      spentStateRescan: true,
      oracleIsSpent: true,
      seedToken: token,
    });
    mod = module;

    expect(getTokensMap(module).has(token.id)).toBe(true);
    expect(getInstalledWorker(module)).not.toBeNull();

    await module.load();
    // load() schedules the sweep fire-and-forget; await microtasks to
    // let the promise chain settle. A small `await Promise.resolve()`
    // tick chain matches the `void (async () => {...})()` pattern in
    // PaymentsModule.load().
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The seeded token was reported as spent → default closure removes it.
    expect(getTokensMap(module).has(token.id)).toBe(false);
    // The oracle was actually consulted (defense-in-depth ran).
    expect(oracle.isSpent).toHaveBeenCalled();
    // The canonical event fired so observers (UI / metrics) see the
    // off-record spend.
    const fired = recorder.events.filter(
      (e) => e.type === 'transfer:off-record-spent',
    );
    expect(fired.length).toBeGreaterThanOrEqual(1);
    const data = fired[0].data as { tokenId: string };
    expect(data.tokenId).toBe(token.id);
  });

  it('respects features.recoveryAggregatorCheck=false (operator opt-out)', async () => {
    const token = makeToken({ id: 'tok-recovery-optout' });
    const { module, oracle } = await buildModule({
      recoveryAggregatorCheck: false,
      spentStateRescan: true,
      oracleIsSpent: true,
      seedToken: token,
    });
    mod = module;

    await module.load();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // No load-triggered scan → token survives even though the oracle
    // would report it as spent. (The periodic worker will catch it
    // eventually, but the recovery window is what this test asserts.)
    expect(getTokensMap(module).has(token.id)).toBe(true);
    // The load-time call should not have hit the oracle. The periodic
    // worker schedules its first cycle after `intervalMs` (default
    // 5 min), so within the test window we should see zero calls.
    expect(oracle.isSpent).not.toHaveBeenCalled();
  });

  it('no-op when spentStateRescan=false (worker not installed)', async () => {
    const token = makeToken({ id: 'tok-recovery-noworker' });
    const { module, oracle, recorder } = await buildModule({
      recoveryAggregatorCheck: true,
      spentStateRescan: false,
      oracleIsSpent: true,
      seedToken: token,
    });
    mod = module;

    expect(getInstalledWorker(module)).toBeNull();

    await module.load();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(getTokensMap(module).has(token.id)).toBe(true);
    expect(oracle.isSpent).not.toHaveBeenCalled();
    expect(
      recorder.events.filter((e) => e.type === 'transfer:off-record-spent'),
    ).toHaveLength(0);
  });

  it('sweep failure does NOT break load() (graceful degradation)', async () => {
    const token = makeToken({ id: 'tok-recovery-throwy' });
    const { module, oracle } = await buildModule({
      recoveryAggregatorCheck: true,
      spentStateRescan: true,
      oracleIsSpent: false,
      seedToken: token,
    });
    mod = module;

    // Force the worker's scan cycle to throw.
    oracle.isSpent.mockImplementation(async () => {
      throw new Error('mock oracle failure');
    });

    // load() must STILL resolve cleanly — the sweep is fire-and-forget
    // and the catch in PaymentsModule.load() converts the throw to a
    // warn-level log line.
    await expect(module.load()).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Token unaffected; the throw was caught.
    expect(getTokensMap(module).has(token.id)).toBe(true);
  });
});
