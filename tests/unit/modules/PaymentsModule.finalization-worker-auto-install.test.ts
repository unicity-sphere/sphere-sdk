/**
 * Tests for auto-installation of the FinalizationWorkerSender (Phase 9.6.D).
 *
 * Verifies:
 *  1. When `senderUxf=true` and oracle provides `getAggregatorClient()`,
 *     `initialize()` constructs + starts a FinalizationWorkerSender.
 *  2. When `senderUxf=false`, no worker is constructed.
 *  3. When `features.finalizationWorker=false`, no worker is constructed.
 *  4. When a consumer calls `installFinalizationWorkerSender(myWorker)` BEFORE
 *     `initialize()`, that worker wins (auto-install gate skipped).
 *  5. `destroy()` stops the auto-installed worker.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPaymentsModule,
} from '../../../modules/payments/PaymentsModule';
import {
  FinalizationWorkerSender,
} from '../../../modules/payments/transfer/finalization-worker-sender';
import type { FullIdentity } from '../../../types';
import type { StorageProvider } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';

// =============================================================================
// Shared mocks (minimal — no network or crypto)
// =============================================================================

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
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../../serialization/txf-serializer', () => ({
  tokenToTxf: vi.fn().mockReturnValue(null),
  txfToToken: vi.fn(),
  getCurrentStateHash: vi.fn().mockReturnValue(''),
  buildTxfStorageData: vi.fn().mockResolvedValue({}),
  parseTxfStorageData: vi.fn().mockReturnValue({ tokens: [], tombstones: [], sent: [] }),
}));

// =============================================================================
// Helpers
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
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    delete: vi.fn(async (k: string) => { store.delete(k); }),
    clear: vi.fn(async () => store.clear()),
    has: vi.fn(async (k: string) => store.has(k)),
    keys: vi.fn(async () => [...store.keys()]),
  } as unknown as StorageProvider;
}

function makeTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(true),
    publishNametag: vi.fn().mockResolvedValue(undefined),
  } as unknown as TransportProvider;
}

/** Oracle WITH a getAggregatorClient (simulates real UnicityAggregatorProvider). */
function makeOracleWithAggregator(): OracleProvider {
  const fakeAggregatorClient = {}; // non-null stub
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getStateTransitionClient: vi.fn().mockReturnValue(null),
    getAggregatorClient: vi.fn().mockReturnValue(fakeAggregatorClient),
    waitForProofSdk: vi.fn(),
    getProof: vi.fn().mockResolvedValue(null),
  } as unknown as OracleProvider;
}

/** Oracle WITHOUT a getAggregatorClient (simulates a stub oracle in tests). */
function makeOracleWithoutAggregator(): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getStateTransitionClient: vi.fn().mockReturnValue(null),
    // No getAggregatorClient method at all.
    waitForProofSdk: vi.fn(),
    getProof: vi.fn().mockResolvedValue(null),
  } as unknown as OracleProvider;
}

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule — FinalizationWorkerSender auto-install (Phase 9.6.D)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 1. Auto-install when senderUxf=true and oracle has getAggregatorClient
  // ---------------------------------------------------------------------------

  it('constructs and starts a FinalizationWorkerSender when senderUxf defaults to true and oracle has getAggregatorClient', () => {
    const module = createPaymentsModule();
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracleWithAggregator(),
      emitEvent: vi.fn(),
    });

    const worker = (module as unknown as { finalizationWorkerSender: unknown }).finalizationWorkerSender;
    expect(worker).not.toBeNull();
    expect(worker).toBeInstanceOf(FinalizationWorkerSender);
    expect((worker as FinalizationWorkerSender).isRunning()).toBe(true);

    module.destroy();
  });

  // ---------------------------------------------------------------------------
  // 2. No worker when senderUxf=false
  // ---------------------------------------------------------------------------

  it('does NOT construct a worker when features.senderUxf is false', () => {
    const module = createPaymentsModule({ features: { senderUxf: false } });
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracleWithAggregator(),
      emitEvent: vi.fn(),
    });

    expect(
      (module as unknown as { finalizationWorkerSender: unknown }).finalizationWorkerSender,
    ).toBeNull();

    module.destroy();
  });

  // ---------------------------------------------------------------------------
  // 3. No worker when finalizationWorker=false
  // ---------------------------------------------------------------------------

  it('does NOT construct a worker when features.finalizationWorker is false', () => {
    const module = createPaymentsModule({
      features: { senderUxf: true, finalizationWorker: false },
    });
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracleWithAggregator(),
      emitEvent: vi.fn(),
    });

    expect(
      (module as unknown as { finalizationWorkerSender: unknown }).finalizationWorkerSender,
    ).toBeNull();

    module.destroy();
  });

  // ---------------------------------------------------------------------------
  // 4. No worker when oracle has no getAggregatorClient
  // ---------------------------------------------------------------------------

  it('skips auto-install when oracle.getAggregatorClient() is absent/null', () => {
    const module = createPaymentsModule();
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracleWithoutAggregator(),
      emitEvent: vi.fn(),
    });

    expect(
      (module as unknown as { finalizationWorkerSender: unknown }).finalizationWorkerSender,
    ).toBeNull();

    module.destroy();
  });

  // ---------------------------------------------------------------------------
  // 5. Consumer-installed worker wins over auto-install
  // ---------------------------------------------------------------------------

  it('does NOT replace a consumer-installed worker when initialize() is called', () => {
    const module = createPaymentsModule({ features: { senderUxf: true } });

    // Minimal stub worker that satisfies the FinalizationWorkerSender interface.
    const mockWorker = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockReturnValue(false),
      processOne: vi.fn(),
    } as unknown as FinalizationWorkerSender;

    // Install before initialize().
    module.installFinalizationWorkerSender(mockWorker);

    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracleWithAggregator(),
      emitEvent: vi.fn(),
    });

    // Auto-install gate must have been skipped — consumer worker still in place.
    const installed = (module as unknown as { finalizationWorkerSender: unknown }).finalizationWorkerSender;
    expect(installed).toBe(mockWorker);

    module.destroy();
  });

  // ---------------------------------------------------------------------------
  // 6. destroy() stops the auto-installed worker
  // ---------------------------------------------------------------------------

  it('stops the auto-installed worker on module.destroy()', () => {
    const module = createPaymentsModule();
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracleWithAggregator(),
      emitEvent: vi.fn(),
    });

    const worker = (module as unknown as { finalizationWorkerSender: FinalizationWorkerSender }).finalizationWorkerSender!;
    expect(worker).toBeInstanceOf(FinalizationWorkerSender);

    const stopSpy = vi.spyOn(worker, 'stop');
    module.destroy();

    expect(stopSpy).toHaveBeenCalled();
    // Field is cleared after destroy.
    expect(
      (module as unknown as { finalizationWorkerSender: unknown }).finalizationWorkerSender,
    ).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 7. installFinalizationWorkerSender() after initialize() starts worker immediately
  // ---------------------------------------------------------------------------

  it('starts the worker immediately when installFinalizationWorkerSender() is called after initialize()', () => {
    const module = createPaymentsModule({
      // Disable auto-install so we start clean.
      features: { finalizationWorker: false },
    });
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracleWithAggregator(),
      emitEvent: vi.fn(),
    });

    const mockWorker = {
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      isRunning: vi.fn().mockReturnValue(false),
      processOne: vi.fn(),
    } as unknown as FinalizationWorkerSender;

    module.installFinalizationWorkerSender(mockWorker);

    expect(mockWorker.start).toHaveBeenCalled();

    module.destroy();
  });
});
