/**
 * Issue #223 — verify that `PaymentsModuleDependencies.cidFetchGateways`
 * is wired through to the auto-installed `IngestWorkerPool`'s
 * `cidOptions`. Without this wire, every `kind: 'uxf-cid'` event hits
 * `acquireBundle`'s `BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED` reject
 * branch and is silently dropped (root cause #1 of the bug).
 *
 * Symmetric to `providers-publish-to-ipfs.test.ts` (Issue #200) /
 * `providers-cid-fetch-gateways-223.test.ts` (this issue): the provider
 * factory exposes the gateway list; the wiring through Sphere is
 * exercised by the e2e isolation test; this file pins the
 * PaymentsModule's contract.
 *
 * Test strategy: reach into the auto-installed pool (private field) and
 * read its `cidOptions` (also private). The private-field access is a
 * runtime test concession — the alternative would be exposing
 * `cidOptions` on a public accessor purely for the test, which would
 * leak production surface for no real-world consumer benefit. The cast
 * stays IN THIS TEST FILE only.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPaymentsModule } from '../../../modules/payments/PaymentsModule';
import type { IngestWorkerPool } from '../../../extensions/uxf/pipeline/ingest-worker-pool';
import type { AcquireBundleCidOptions } from '../../../extensions/uxf/pipeline/bundle-acquirer';
import type { FullIdentity } from '../../../types';
import type { StorageProvider } from '../../../storage';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';

// =============================================================================
// SDK mocks — same shape as PaymentsModule.uxf-auto-ingest.test.ts since this
// file shares the construction path. We don't exercise any SDK calls — only
// PaymentsModule.initialize() — so the mocks just need to be non-throwing.
// =============================================================================

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: { fromJSON: vi.fn() },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class { },
}));
vi.mock('../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({ getDefinition: () => null, getIconUrl: () => null }),
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
// Helpers — minimal stub deps; PaymentsModule.initialize is the only call.
// =============================================================================

function makeIdentity(): FullIdentity {
  return {
    chainPubkey: '02' + 'a'.repeat(64),
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

function makeOracle(): OracleProvider {
  return {
    validateToken: vi.fn().mockResolvedValue({ valid: true }),
    getStateTransitionClient: vi.fn().mockReturnValue(null),
    waitForProofSdk: vi.fn(),
  } as unknown as OracleProvider;
}

function readPoolCidOptions(module: unknown): AcquireBundleCidOptions | undefined {
  // Reach into private fields — see file-level docstring for rationale.
  const pool = (module as { ingestPool: IngestWorkerPool | null }).ingestPool;
  if (!pool) return undefined;
  return (pool as unknown as { cidOptions?: AcquireBundleCidOptions }).cidOptions;
}

// =============================================================================
// Tests
// =============================================================================

describe('PaymentsModule — cidFetchGateways → IngestWorkerPool cidOptions wiring (Issue #223)', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('populates cidOptions.gateways when deps.cidFetchGateways is a non-empty list', () => {
    const module = createPaymentsModule();
    const gateways = ['https://ipfs1.example.test', 'https://ipfs2.example.test'];

    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracle(),
      emitEvent: vi.fn(),
      cidFetchGateways: gateways,
    });

    const cidOptions = readPoolCidOptions(module);
    expect(cidOptions).toBeDefined();
    expect(cidOptions?.gateways).toEqual(gateways);

    module.destroy();
  });

  it('snapshots the gateway list (mutations to the caller array do not affect pool)', () => {
    // Important: PaymentsModule should NOT hold a live reference to the
    // caller's array. A consumer mutating the array post-initialize
    // would otherwise change the recipient's fetch behavior at runtime.
    const module = createPaymentsModule();
    const gateways = ['https://snapshot.example.test'];

    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracle(),
      emitEvent: vi.fn(),
      cidFetchGateways: gateways,
    });

    // Mutate the caller's array AFTER initialize.
    gateways.push('https://injected.example.test');

    const cidOptions = readPoolCidOptions(module);
    expect(cidOptions?.gateways).toEqual(['https://snapshot.example.test']);

    module.destroy();
  });

  it('leaves cidOptions undefined when deps.cidFetchGateways is omitted', () => {
    // Pre-fix legacy behaviour — opt-out consumers (no IPFS) keep the
    // drop-silent semantics so we don't break anyone relying on it.
    const module = createPaymentsModule();

    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracle(),
      emitEvent: vi.fn(),
      // cidFetchGateways intentionally omitted
    });

    const cidOptions = readPoolCidOptions(module);
    expect(cidOptions).toBeUndefined();

    module.destroy();
  });

  it('leaves cidOptions undefined when deps.cidFetchGateways is an empty array', () => {
    // Empty array semantically means "no gateways" — we must NOT
    // construct a degenerate `cidOptions: { gateways: [] }` because
    // `acquireBundle` rejects that exact shape with
    // `BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED`. Better to be
    // structurally undefined so the worker drops the bundle via the
    // documented legacy path, NOT via a spurious "empty list" error.
    const module = createPaymentsModule();

    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracle(),
      emitEvent: vi.fn(),
      cidFetchGateways: [],
    });

    const cidOptions = readPoolCidOptions(module);
    expect(cidOptions).toBeUndefined();

    module.destroy();
  });

  it('populates cidOptions.emit so the bundle-acquirer can fire transfer:fetch-failed (steelman fix)', () => {
    // The bundle-acquirer's uxf-cid branch calls
    // `cidOptions.emit?.('transfer:fetch-failed', ...)` at the W13
    // telemetry boundary. The initial #223 fix constructed
    // `cidOptions = { gateways: [...] }` WITHOUT `emit`, so the
    // production event was silently never fired even though the
    // bundle-acquirer code claimed to fire it. This test pins the
    // contract: when gateways are wired, `emit` MUST also be wired,
    // and the wired emit MUST forward to `deps.emitEvent` so
    // consumers who subscribe via `sphere.on(...)` see the event.
    const module = createPaymentsModule();
    const emitEvent = vi.fn();
    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracle(),
      emitEvent,
      cidFetchGateways: ['https://gw.example.test'],
    });

    const cidOptions = readPoolCidOptions(module);
    expect(cidOptions).toBeDefined();
    expect(typeof cidOptions?.emit).toBe('function');

    // Drive the emit and assert the deps.emitEvent forward.
    cidOptions!.emit!('transfer:fetch-failed', {
      bundleCid: 'bafytest',
      senderTransportPubkey: 'b'.repeat(64),
      gatewaysAttempted: ['https://gw.example.test'],
      failureReasons: ['unit-test'],
    });
    expect(emitEvent).toHaveBeenCalledWith(
      'transfer:fetch-failed',
      expect.objectContaining({
        bundleCid: 'bafytest',
      }),
    );

    module.destroy();
  });

  it('does NOT install a pool when features.recipientUxf is false (no cidOptions either)', () => {
    // Opt-out via feature flag still wins. cidFetchGateways is
    // irrelevant when no pool is installed at all.
    const module = createPaymentsModule({ features: { recipientUxf: false } });

    module.initialize({
      identity: makeIdentity(),
      storage: makeStorage(),
      transport: makeTransport(),
      oracle: makeOracle(),
      emitEvent: vi.fn(),
      cidFetchGateways: ['https://should-be-ignored.example.test'],
    });

    const pool = (module as unknown as { ingestPool: IngestWorkerPool | null }).ingestPool;
    expect(pool).toBeNull();

    module.destroy();
  });
});
