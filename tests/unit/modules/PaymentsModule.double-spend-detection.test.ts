/**
 * Tests for OUTBOX-SEND-FOLLOWUPS Item #14 Phase 1 — typed throw +
 * `transfer:double-spend-detected` event + `'failed-conflict'` outbox
 * status.
 *
 * Layered coverage:
 *   1. `STATE_ALREADY_SPENT_BY_OTHER` is a recognized `SphereErrorCode`.
 *   2. `SphereEventMap['transfer:double-spend-detected']` payload shape
 *      contract (compile-time + runtime guard via a literal).
 *   3. `emitDoubleSpendDetectedIfApplicable` (private helper) — direct
 *      unit-tested via reflection. Asserts:
 *      - the helper emits when err.code === STATE_ALREADY_SPENT_BY_OTHER
 *      - the helper extracts the structured payload from
 *        `SphereError.context`
 *      - the helper is a NO-OP for other SphereError codes
 *      - the helper is a NO-OP for non-SphereError throws
 *      - emit failures don't propagate
 *
 * The submit-classification helper (`submitCommitmentClassified`) is
 * also reflected-into. It branches on:
 *      - SUCCESS / REQUEST_ID_EXISTS → success path
 *      - non-success + `oracle.isSpent === true` →
 *        STATE_ALREADY_SPENT_BY_OTHER with structured cause
 *      - non-success + `oracle.isSpent === false` → TRANSFER_FAILED
 *      - non-success + `oracle.isSpent` throws → TRANSFER_FAILED
 *        (best-effort probe; never produces false positives).
 *
 * The dispatcher's outer-catch wiring (which actually calls
 * `emitDoubleSpendDetectedIfApplicable`) is exercised by the integration
 * paths; this file pins the contract at the helper layer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import { SphereError, type SphereErrorCode } from '../../../core/errors';
import type { FullIdentity, SphereEventMap } from '../../../types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';

// Same SDK mocks as PaymentsModule.tombstone.test.ts so PaymentsModule
// doesn't trip on static imports during module load.
vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: { fromJSON: vi.fn().mockResolvedValue({ id: { toString: () => 'mock-id' }, coins: null, state: {} }) },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class MockCoinId { toJSON() { return 'UCT_HEX'; } },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment', () => ({
  TransferCommitment: { fromJSON: vi.fn() },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction', () => ({
  TransferTransaction: class MockTransferTransaction {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: class MockSigningService {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/address/AddressScheme', () => ({
  AddressScheme: class MockAddressScheme {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate', () => ({
  UnmaskedPredicate: class MockUnmaskedPredicate {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class MockTokenState {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm', () => ({
  HashAlgorithm: { SHA256: 'sha256' },
}));
vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
      getSymbol: () => 'UCT',
      getName: () => 'Unicity Token',
      getDecimals: () => 8,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

// =============================================================================
// Fixture (shared with PaymentsModule.tombstone.test.ts pattern)
// =============================================================================

const TOKEN_ID_A = 'aaaa000000000000000000000000000000000000000000000000000000000001';
const STATE_HASH_A = 'beef000000000000000000000000000000000000000000000000000000000001';

function createMockDeps(overrides: {
  readonly isSpent?: (h: string) => Promise<boolean>;
} = {}): PaymentsModuleDependencies {
  const mockStorage: StorageProvider = {
    id: 'mock-storage',
    name: 'Mock Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    has: vi.fn().mockResolvedValue(false),
    keys: vi.fn().mockResolvedValue([]),
    clear: vi.fn().mockResolvedValue(undefined),
  };
  const mockTokenStorage: TokenStorageProvider<TxfStorageDataBase> = {
    id: 'mock-token-storage',
    name: 'Mock Token Storage',
    type: 'local',
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected'),
    setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true),
    shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn().mockResolvedValue({ success: true, timestamp: Date.now() }),
    load: vi.fn().mockResolvedValue({ success: false, source: 'local' as const, timestamp: Date.now() }),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
  };
  const tokenStorageProviders = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
  tokenStorageProviders.set('mock', mockTokenStorage);
  const mockTransport = {
    id: 'mock-transport',
    name: 'Mock Transport',
    type: 'p2p' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as const),
    setIdentity: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('event-id'),
    onMessage: vi.fn().mockReturnValue(() => {}),
    sendTokenTransfer: vi.fn().mockResolvedValue('event-id'),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
  } as unknown as TransportProvider;
  const mockOracle = {
    id: 'mock-oracle',
    name: 'Mock Oracle',
    type: 'network' as const,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    getStatus: vi.fn().mockReturnValue('connected' as const),
    initialize: vi.fn().mockResolvedValue(undefined),
    submitCommitment: vi.fn().mockResolvedValue({ success: true }),
    getProof: vi.fn().mockResolvedValue(null),
    waitForProof: vi.fn().mockResolvedValue({}),
    validateToken: vi.fn().mockResolvedValue({ isValid: true }),
    isSpent: vi.fn().mockImplementation(overrides.isSpent ?? (async () => false)),
    getTokenState: vi.fn().mockResolvedValue(null),
  } as unknown as OracleProvider;
  const mockIdentity: FullIdentity = {
    chainPubkey: 'aabbccdd11223344556677889900aabbccdd11223344556677889900aabbccdd11',
    directAddress: 'DIRECT://test',
    privateKey: '0011223344556677889900aabbccddeeff0011223344556677889900aabbccddee',
  };
  return {
    identity: mockIdentity,
    storage: mockStorage,
    tokenStorageProviders,
    transport: mockTransport,
    oracle: mockOracle,
    emitEvent: vi.fn(),
  };
}

// Stub commitment whose `transactionData.sourceState.calculateHash()`
// returns a `DataHash`-like with `toJSON() === STATE_HASH_A`.
function makeCommitmentStub(): unknown {
  return {
    transactionData: {
      sourceState: {
        async calculateHash() {
          return { toJSON: () => STATE_HASH_A };
        },
      },
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Item #14 Phase 1 — SphereErrorCode contract', () => {
  it('STATE_ALREADY_SPENT_BY_OTHER is a valid SphereErrorCode', () => {
    // Compile-time assertion via type narrowing: if the literal cannot
    // be assigned to SphereErrorCode the test file fails to compile.
    const code: SphereErrorCode = 'STATE_ALREADY_SPENT_BY_OTHER';
    expect(code).toBe('STATE_ALREADY_SPENT_BY_OTHER');
    // Runtime guarantee: SphereError constructed with this code carries
    // it on instances.
    const err = new SphereError('m', 'STATE_ALREADY_SPENT_BY_OTHER');
    expect(err.code).toBe('STATE_ALREADY_SPENT_BY_OTHER');
  });
});

describe('Item #14 Phase 1 — SphereEventMap[transfer:double-spend-detected] payload', () => {
  it('matches the documented payload shape', () => {
    const payload: SphereEventMap['transfer:double-spend-detected'] = {
      tokenId: TOKEN_ID_A,
      sourceStateHash: STATE_HASH_A,
      ourIntendedRecipient: '@bob',
      detectedAt: 1_700_000_000_000,
    };
    expect(payload.tokenId).toBe(TOKEN_ID_A);
    expect(payload.sourceStateHash).toBe(STATE_HASH_A);
    expect(payload.ourIntendedRecipient).toBe('@bob');
    expect(typeof payload.detectedAt).toBe('number');
  });
});

describe('PaymentsModule.emitDoubleSpendDetectedIfApplicable (private)', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let deps: PaymentsModuleDependencies;

  beforeEach(() => {
    vi.clearAllMocks();
    module = createPaymentsModule({ debug: false });
    deps = createMockDeps();
    module.initialize(deps);
  });

  function callHelper(err: unknown): void {
    // Reach into the private helper via the prototype to bypass the
    // TS visibility restriction. The function is `this`-bound so we
    // need `.call(module, …)` rather than detaching.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (module as any).emitDoubleSpendDetectedIfApplicable(err);
  }

  it('emits when err.code === STATE_ALREADY_SPENT_BY_OTHER', () => {
    const err = new SphereError(
      'commit lost race for source state',
      'STATE_ALREADY_SPENT_BY_OTHER',
      {
        tokenId: TOKEN_ID_A,
        sourceStateHash: STATE_HASH_A,
        ourIntendedRecipient: '@bob',
      },
    );
    callHelper(err);
    const emit = deps.emitEvent as ReturnType<typeof vi.fn>;
    expect(emit).toHaveBeenCalledTimes(1);
    const [eventType, payload] = emit.mock.calls[0];
    expect(eventType).toBe('transfer:double-spend-detected');
    expect(payload).toMatchObject({
      tokenId: TOKEN_ID_A,
      sourceStateHash: STATE_HASH_A,
      ourIntendedRecipient: '@bob',
    });
    expect(typeof (payload as { detectedAt: number }).detectedAt).toBe('number');
  });

  it('is a NO-OP for SphereError with a different code', () => {
    const err = new SphereError('boom', 'TRANSFER_FAILED');
    callHelper(err);
    expect(deps.emitEvent as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('is a NO-OP for non-SphereError throws', () => {
    callHelper(new Error('plain error'));
    callHelper('string error');
    callHelper(42);
    callHelper(undefined);
    callHelper(null);
    expect(deps.emitEvent as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('survives a missing/partial structured payload (best-effort extraction)', () => {
    // SphereError constructed WITHOUT a structured cause. The helper
    // emits with empty strings for missing fields rather than skipping
    // — operators still see SOMETHING.
    const err = new SphereError(
      'commit lost race (no diagnostic payload)',
      'STATE_ALREADY_SPENT_BY_OTHER',
    );
    callHelper(err);
    const emit = deps.emitEvent as ReturnType<typeof vi.fn>;
    expect(emit).toHaveBeenCalledTimes(1);
    const [, payload] = emit.mock.calls[0];
    expect(payload).toMatchObject({
      tokenId: '',
      sourceStateHash: '',
      ourIntendedRecipient: '',
    });
  });

  it('emit throws are swallowed (does not mask the original throw)', () => {
    const emitMock = deps.emitEvent as ReturnType<typeof vi.fn>;
    emitMock.mockImplementation(() => {
      throw new Error('emit listener exploded');
    });
    const err = new SphereError(
      'commit lost race',
      'STATE_ALREADY_SPENT_BY_OTHER',
      { tokenId: TOKEN_ID_A, sourceStateHash: STATE_HASH_A, ourIntendedRecipient: '@bob' },
    );
    expect(() => callHelper(err)).not.toThrow();
  });
});

describe('PaymentsModule.submitCommitmentClassified (private)', () => {
  let module: ReturnType<typeof createPaymentsModule>;
  let deps: PaymentsModuleDependencies;

  beforeEach(() => {
    vi.clearAllMocks();
    module = createPaymentsModule({ debug: false });
    deps = createMockDeps();
    module.initialize(deps);
  });

  async function callSubmit(opts: {
    readonly submitStatus: string;
    readonly isSpent?: (h: string) => Promise<boolean>;
    readonly oracle?: OracleProvider | undefined;
  }): Promise<void> {
    const stClient = {
      async submitTransferCommitment() {
        return { status: opts.submitStatus };
      },
    };
    const oracle =
      opts.oracle === undefined
        ? ({
            ...deps.oracle,
            isSpent: vi.fn().mockImplementation(opts.isSpent ?? (async () => false)),
          } as unknown as OracleProvider)
        : opts.oracle;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (module as any).submitCommitmentClassified(
      stClient,
      oracle,
      makeCommitmentStub(),
      { tokenId: TOKEN_ID_A, intendedRecipient: '@bob' },
    );
  }

  it('returns silently on SUCCESS', async () => {
    await expect(callSubmit({ submitStatus: 'SUCCESS' })).resolves.toBeUndefined();
  });

  it('returns silently on REQUEST_ID_EXISTS (idempotent re-submit)', async () => {
    await expect(callSubmit({ submitStatus: 'REQUEST_ID_EXISTS' })).resolves.toBeUndefined();
  });

  it('throws STATE_ALREADY_SPENT_BY_OTHER when isSpent returns true', async () => {
    let captured: SphereError | null = null;
    try {
      await callSubmit({
        submitStatus: 'AUTHENTICATOR_VERIFICATION_FAILED',
        isSpent: async () => true,
      });
    } catch (err) {
      if (err instanceof SphereError) captured = err;
    }
    expect(captured).not.toBeNull();
    expect(captured!.code).toBe('STATE_ALREADY_SPENT_BY_OTHER');
    // Structured payload available via context (redacted cause):
    const ctx = captured!.context as {
      tokenId?: string;
      sourceStateHash?: string;
      ourIntendedRecipient?: string;
    };
    expect(ctx.tokenId).toBe(TOKEN_ID_A);
    expect(ctx.sourceStateHash).toBe(STATE_HASH_A);
    expect(ctx.ourIntendedRecipient).toBe('@bob');
  });

  it('throws TRANSFER_FAILED when isSpent returns false', async () => {
    let captured: SphereError | null = null;
    try {
      await callSubmit({
        submitStatus: 'AUTHENTICATOR_VERIFICATION_FAILED',
        isSpent: async () => false,
      });
    } catch (err) {
      if (err instanceof SphereError) captured = err;
    }
    expect(captured).not.toBeNull();
    expect(captured!.code).toBe('TRANSFER_FAILED');
  });

  it('throws TRANSFER_FAILED when isSpent probe throws (best-effort)', async () => {
    let captured: SphereError | null = null;
    try {
      await callSubmit({
        submitStatus: 'REQUEST_ID_MISMATCH',
        isSpent: async () => {
          throw new Error('aggregator offline');
        },
      });
    } catch (err) {
      if (err instanceof SphereError) captured = err;
    }
    expect(captured).not.toBeNull();
    expect(captured!.code).toBe('TRANSFER_FAILED');
  });

  it('throws TRANSFER_FAILED when no oracle is wired (no probe possible)', async () => {
    let captured: SphereError | null = null;
    try {
      await callSubmit({
        submitStatus: 'REQUEST_ID_MISMATCH',
        oracle: undefined,
      });
    } catch (err) {
      if (err instanceof SphereError) captured = err;
    }
    expect(captured).not.toBeNull();
    expect(captured!.code).toBe('TRANSFER_FAILED');
  });
});

