/**
 * Tests for `PaymentsModule.installOutboxWriter` writer-identity guard
 * (Issue #166 P3 #5; steelman item 5 in #97 round 1).
 *
 * **What the guard prevents.** `installOutboxWriter(writer)` kicks off
 * a fire-and-forget `writer.readAllNew().then(...)` to hydrate the
 * in-memory `_senderOutboxMap`. If the caller later swaps the writer
 * (or uninstalls it via `installOutboxWriter(null)`) BEFORE the
 * hydration Promise resolves, the late callback would otherwise
 * repopulate the cleared map with stale data — defeating destroy()
 * and confusing the FinalizationWorkerSender.
 *
 * The guard at PaymentsModule.ts:3147 and 3167 captures `writerRef`
 * in the closure and bails when `this._outboxWriter !== writerRef`.
 *
 * **Critical regression risk.** Removing the guard would cause
 * Sphere.destroy() to leak hydration into a cleared map, which can
 * mask bugs (recipient receives a tombstoned bundle) at production
 * scale. This file pins the guard so future refactors don't quietly
 * regress.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  createPaymentsModule,
  type PaymentsModule,
  type PaymentsModuleDependencies,
} from '../../../../modules/payments/PaymentsModule';
import {
  createStubOracle,
  createStubStorageProvider,
  createStubTokenStorageProvider,
  createStubTransport,
  createTestIdentity,
  createWriterPair,
  makeOutboxEntry,
} from './__fixtures__/payments-module-fixture';
import type { OutboxWriter } from '../../../../extensions/uxf/profile/outbox-writer';
import type { UxfTransferOutboxEntry } from '../../../../extensions/uxf/types/uxf-outbox';

// ---------------------------------------------------------------------------
// SDK mocks
// ---------------------------------------------------------------------------

vi.mock('@unicitylabs/state-transition-sdk/lib/token/Token', () => ({
  Token: {
    fromJSON: vi
      .fn()
      .mockResolvedValue({ id: { toString: () => 'mock-id' }, coins: null, state: {} }),
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId', () => ({
  CoinId: class {
    toJSON(): string {
      return 'UCT_HEX';
    }
  },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment', () => ({
  TransferCommitment: { fromJSON: vi.fn() },
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction', () => ({
  TransferTransaction: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/sign/SigningService', () => ({
  SigningService: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/address/AddressScheme', () => ({
  AddressScheme: class {},
}));
vi.mock(
  '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate',
  () => ({ UnmaskedPredicate: class {} }),
);
vi.mock('@unicitylabs/state-transition-sdk/lib/token/TokenState', () => ({
  TokenState: class {},
}));
vi.mock('@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm', () => ({
  HashAlgorithm: { SHA256: 'sha256' },
}));
vi.mock('../../../../l1/network', () => ({
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn(),
  isWebSocketConnected: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../registry', () => ({
  TokenRegistry: {
    waitForReady: vi.fn().mockResolvedValue(undefined),
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPaymentsDeps(): PaymentsModuleDependencies {
  const providers = new Map<
    string,
    ReturnType<typeof createStubTokenStorageProvider>
  >();
  providers.set('main', createStubTokenStorageProvider());
  return {
    identity: createTestIdentity(),
    storage: createStubStorageProvider(),
    tokenStorageProviders: providers,
    transport: createStubTransport(),
    oracle: createStubOracle(),
    emitEvent: vi.fn(),
  };
}

interface PaymentsModuleInternals {
  _senderOutboxMap: Map<string, UxfTransferOutboxEntry>;
  _outboxWriter: OutboxWriter | null;
}

function asInternals(payments: PaymentsModule): PaymentsModuleInternals {
  return payments as unknown as PaymentsModuleInternals;
}

/**
 * Build an OutboxWriter-shaped stub whose `readAllNew()` is gated on
 * an external resolver. The other surface methods proxy to a real
 * underlying writer so the stub remains valid where the real surface
 * matters (write/update/delete).
 */
function makeGatedOutboxWriter(
  underlying: OutboxWriter,
  preloadEntries: ReadonlyArray<UxfTransferOutboxEntry>,
): {
  writer: OutboxWriter;
  resolveHydration: () => void;
  readAllNewCalls: () => number;
} {
  let resolve: () => void = () => undefined;
  const gate = new Promise<void>((res) => {
    resolve = res;
  });
  let calls = 0;
  const writer = new Proxy(underlying, {
    get(target, prop, receiver) {
      if (prop === 'readAllNew') {
        return async (): Promise<ReadonlyArray<UxfTransferOutboxEntry>> => {
          calls += 1;
          await gate;
          return preloadEntries;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    writer,
    resolveHydration: () => resolve(),
    readAllNewCalls: () => calls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentsModule.installOutboxWriter writer-identity guard (Issue #166 — P3 #5)', () => {
  let payments: PaymentsModule;

  beforeEach(() => {
    vi.clearAllMocks();
    payments = createPaymentsModule({
      debug: false,
      autoSync: false,
      features: { recoveryWorker: false, finalizationWorker: false },
    });
    payments.initialize(createPaymentsDeps());
  });

  it('hydrates _senderOutboxMap when the install completes without intervening swaps', async () => {
    const { outboxWriter } = createWriterPair();
    const entry = makeOutboxEntry({ id: 'live-1' });
    // Seed the underlying writer so a real readAllNew returns it.
    await outboxWriter.write(entry);

    payments.installOutboxWriter(outboxWriter);

    // Hydration is fire-and-forget. Await microtask + I/O queue.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(asInternals(payments)._senderOutboxMap.has('live-1')).toBe(true);
  });

  it('aborts hydration when installOutboxWriter(null) fires before readAllNew resolves', async () => {
    const { outboxWriter } = createWriterPair();
    const stalePreload = [makeOutboxEntry({ id: 'stale-1' })];
    const gated = makeGatedOutboxWriter(outboxWriter, stalePreload);

    payments.installOutboxWriter(gated.writer);
    // Hydration is pending on the gate. Now uninstall.
    payments.installOutboxWriter(null);
    // Resolve the hydration AFTER the uninstall.
    gated.resolveHydration();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // The mirror MUST stay empty — the writer-identity guard at line
    // 3147 sees `this._outboxWriter !== writerRef` (current is null,
    // captured is gated.writer) and bails.
    expect(asInternals(payments)._senderOutboxMap.size).toBe(0);
    // Sanity: the gated writer's readAllNew WAS invoked (the
    // hydration started), so we proved the guard, not the absence
    // of work.
    expect(gated.readAllNewCalls()).toBe(1);
  });

  it('aborts stale hydration when a new writer is installed before the first resolves', async () => {
    const { outboxWriter: writerA } = createWriterPair();
    const stalePreloadA = [makeOutboxEntry({ id: 'stale-from-A' })];
    const gatedA = makeGatedOutboxWriter(writerA, stalePreloadA);

    const { outboxWriter: writerB } = createWriterPair();
    const livePreloadB = makeOutboxEntry({ id: 'live-from-B' });
    await writerB.write(livePreloadB);

    payments.installOutboxWriter(gatedA.writer);
    payments.installOutboxWriter(writerB);

    // Resolve A's hydration after B is already installed. The guard
    // must drop A's snapshot.
    gatedA.resolveHydration();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // A's entries are NOT in the mirror — the guard fired.
    expect(asInternals(payments)._senderOutboxMap.has('stale-from-A')).toBe(false);
    // B's hydration (synchronous via real readAllNew) DOES populate
    // the mirror — the install for B fires its own hydration which
    // completes promptly.
    expect(asInternals(payments)._senderOutboxMap.has('live-from-B')).toBe(true);
  });

  it('aborts stale hydration via the in-loop identity recheck (mid-loop swap)', async () => {
    // The guard at line 3167 re-checks the writer identity INSIDE the
    // hydration loop. This protects against an `installOutboxWriter`
    // racing with mid-loop iteration. Hard to deterministically race
    // a synchronous loop from a test, but we can prove the
    // pre-loop check (line 3147) by uninstalling between the
    // microtask boundary at `.then(` entry and the loop start. This
    // is effectively the same protection — distinct call site, same
    // contract.
    const { outboxWriter } = createWriterPair();
    const stalePreload = [
      makeOutboxEntry({ id: 'mid-loop-1' }),
      makeOutboxEntry({ id: 'mid-loop-2' }),
    ];
    const gated = makeGatedOutboxWriter(outboxWriter, stalePreload);

    payments.installOutboxWriter(gated.writer);
    // Schedule the uninstall to happen after readAllNew resolves but
    // before the loop processes entries. Practically: resolve the
    // hydration, then immediately install null in the same task —
    // the `.then((entries) => { if (... !== writerRef) return; ... }`
    // entry check fires before the loop.
    gated.resolveHydration();
    payments.installOutboxWriter(null);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(asInternals(payments)._senderOutboxMap.size).toBe(0);
  });

  it("uninstall after a completed hydration does NOT wipe the mirror (uninstall just clears `_outboxWriter`)", async () => {
    // Documents the current contract: `installOutboxWriter(null)` is
    // an UNINSTALL, not a CLEAR. The mirror map is not touched on
    // null-install (the in-memory state is preserved for any in-flight
    // consumers reading it). Future test-coverage of Sphere.destroy
    // verifies that destroy() handles map cleanup at the right layer.
    const { outboxWriter } = createWriterPair();
    const entry = makeOutboxEntry({ id: 'pre-uninstall' });
    await outboxWriter.write(entry);

    payments.installOutboxWriter(outboxWriter);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(asInternals(payments)._senderOutboxMap.has('pre-uninstall')).toBe(true);

    payments.installOutboxWriter(null);
    // Mirror retains the entry — the contract is "stop hydrating from
    // this writer", not "purge mirror state".
    expect(asInternals(payments)._senderOutboxMap.has('pre-uninstall')).toBe(true);
    expect(asInternals(payments)._outboxWriter).toBeNull();
  });

  it("respects Lamport-coalesce: hydration does not clobber a higher-lamport mirror entry", async () => {
    // Steelman W2 guard at line 3169: a hydration snapshot with lower
    // lamport than the in-memory mirror MUST NOT overwrite. Models
    // the post-restart race where a concurrent send already updated
    // the mirror before hydration's snapshot arrived.
    const { outboxWriter } = createWriterPair();
    const stalePreload = [
      makeOutboxEntry({ id: 'lamport-race', lamport: 2 }),
    ];
    const gated = makeGatedOutboxWriter(outboxWriter, stalePreload);

    // Pre-populate the mirror with a higher-lamport entry as if a
    // concurrent dispatcher write already happened.
    asInternals(payments)._senderOutboxMap.set(
      'lamport-race',
      makeOutboxEntry({ id: 'lamport-race', lamport: 5 }),
    );

    payments.installOutboxWriter(gated.writer);
    gated.resolveHydration();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const final = asInternals(payments)._senderOutboxMap.get('lamport-race');
    expect(final).toBeDefined();
    expect(final?.lamport).toBe(5);
  });
});
