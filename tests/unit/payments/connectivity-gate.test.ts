/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Issue #312 — PaymentsModule.send() advisory connectivity hint.
 *
 * The send-path reads a callback wired by `Sphere.initializeModules()`
 * that returns `sphere.connectivity.status().aggregator`. The hint is
 * ADVISORY: a `'down'` reading is logged but does NOT refuse the send.
 * The state-transition-sdk transport is the authoritative health
 * signal — it throws `JsonRpcNetworkError` on real transport failures,
 * and ST-SDK exposes no health/ping API so any preflight refuse is a
 * Sphere-SDK invention that risks blocking sends a recovered
 * aggregator would have accepted.
 *
 * Prior behavior (throwing `SphereError('OFFLINE')` on `'down'`) was
 * removed because a transient testnet aggregator outage propagated to
 * a hard-refuse and broke CLI soak §C.2 (invoice pay) and the
 * browser-side send path.
 */

import { describe, it, expect, vi } from 'vitest';
import { PaymentsModule } from '../../../modules/payments/PaymentsModule';
import { isSphereError } from '../../../core/errors';

// Helper: build a minimally-stubbed PaymentsModule that passes
// `ensureInitialized` (which checks `this.deps`) without running full
// initialize() machinery (which would require an aggregator client).
function buildStubModule(): PaymentsModule {
  const module = new PaymentsModule({ features: { senderUxf: true } });
  (module as any).deps = {
    identity: {
      chainPubkey: '02' + '00'.repeat(32),
      l1Address: 'alpha1test',
      privateKey: '00'.repeat(32),
    },
    storage: { get: () => null, set: () => undefined },
    transport: { resolve: async () => null },
    oracle: {},
    emitEvent: () => undefined,
  };
  return module;
}

describe('PaymentsModule advisory gate (Issue #312)', () => {
  const REQUEST = {
    recipient: '@bob',
    coinId: 'UCT',
    amount: '1000000',
  } as const;

  it("proceeds past the gate when it returns 'down' (advisory only)", async () => {
    const module = buildStubModule();
    // Wire the connectivity gate as if Sphere did
    const gateFn = vi.fn(() => 'down' as const);
    (module as any).configureConnectivityGate(gateFn);
    // Spy on the first downstream call inside send() after the gate.
    // The advisory hint MUST NOT short-circuit the dispatcher — this
    // spy MUST be invoked.
    const downstreamSpy = vi.spyOn(
      module as any,
      'maybeEmitCapabilityWarning' as any,
    );
    let caught: unknown;
    try {
      await module.send(REQUEST);
    } catch (e) {
      caught = e;
    }
    // Gate was called once
    expect(gateFn).toHaveBeenCalledTimes(1);
    // Downstream WAS invoked — the send proceeded.
    expect(downstreamSpy).toHaveBeenCalled();
    // Whatever error eventually surfaces, it MUST NOT be the legacy
    // 'OFFLINE' refuse (which is what we just removed).
    if (isSphereError(caught)) {
      expect((caught as any).code).not.toBe('OFFLINE');
    }
  });

  it('proceeds past the gate when gate returns up', async () => {
    const module = buildStubModule();
    (module as any).configureConnectivityGate(() => 'up' as const);
    // Now we expect the dispatcher to be called. Because we haven't
    // fully initialized the module, the dispatcher will throw — but
    // the gate is not the throw source.
    let caught: unknown;
    try {
      await module.send(REQUEST);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // The error code is NOT 'OFFLINE'.
    if (isSphereError(caught)) {
      expect((caught as any).code).not.toBe('OFFLINE');
    }
  });

  it('proceeds past the gate when gate returns degraded', async () => {
    const module = buildStubModule();
    (module as any).configureConnectivityGate(() => 'degraded' as const);
    let caught: unknown;
    try {
      await module.send(REQUEST);
    } catch (e) {
      caught = e;
    }
    if (isSphereError(caught)) {
      expect((caught as any).code).not.toBe('OFFLINE');
    }
  });

  it('proceeds past the gate when gate returns unknown', async () => {
    const module = buildStubModule();
    (module as any).configureConnectivityGate(() => 'unknown' as const);
    let caught: unknown;
    try {
      await module.send(REQUEST);
    } catch (e) {
      caught = e;
    }
    if (isSphereError(caught)) {
      expect((caught as any).code).not.toBe('OFFLINE');
    }
  });

  it('treats a throwing gate as unknown (pass-through)', async () => {
    const module = buildStubModule();
    (module as any).configureConnectivityGate(() => {
      throw new Error('connectivity manager broke');
    });
    let caught: unknown;
    try {
      await module.send(REQUEST);
    } catch (e) {
      caught = e;
    }
    if (isSphereError(caught)) {
      expect((caught as any).code).not.toBe('OFFLINE');
    }
  });

  it('does NOT gate when gate is null (no Sphere wiring)', async () => {
    const module = buildStubModule();
    // No configureConnectivityGate call — gate remains null
    let caught: unknown;
    try {
      await module.send(REQUEST);
    } catch (e) {
      caught = e;
    }
    if (isSphereError(caught)) {
      expect((caught as any).code).not.toBe('OFFLINE');
    }
  });

  it('can be unwired via configureConnectivityGate(null)', async () => {
    const module = buildStubModule();
    const gateFn = vi.fn(() => 'down' as const);
    (module as any).configureConnectivityGate(gateFn);
    // First call: gate is invoked but advisory only — send proceeds.
    try {
      await module.send(REQUEST);
    } catch {
      // Downstream error from the partially-stubbed module is expected;
      // we only care that the gate was consulted.
    }
    expect(gateFn).toHaveBeenCalledTimes(1);
    // Now unwire — subsequent sends MUST NOT touch the gate.
    (module as any).configureConnectivityGate(null);
    let caught: unknown;
    try {
      await module.send(REQUEST);
    } catch (e) {
      caught = e;
    }
    // Still no extra gate calls after unwiring.
    expect(gateFn).toHaveBeenCalledTimes(1);
    if (isSphereError(caught)) {
      expect((caught as any).code).not.toBe('OFFLINE');
    }
  });
});
