/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Issue #312 — PaymentsModule.send() offline gate.
 *
 * The send-path is gated by a callback wired by `Sphere.initializeModules()`
 * that returns `sphere.connectivity.status().aggregator`. When the gate
 * returns `'down'`, send refuses with `SphereError('OFFLINE', { which:
 * 'aggregator' })` BEFORE any state mutation (no aggregator call, no
 * reservation, no Nostr publish).
 *
 * This test exercises the gate at the public entry point. We do NOT
 * fully initialize the module (which would require a real
 * StateTransitionClient) — the gate throws BEFORE `ensureInitialized`
 * even matters because we install our own `_initialized` flag.
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

describe('PaymentsModule offline gate (Issue #312)', () => {
  const REQUEST = {
    recipient: '@bob',
    coinId: 'UCT',
    amount: '1000000',
  } as const;

  it('throws OFFLINE without side effects when gate returns down', async () => {
    const module = buildStubModule();
    // Wire the connectivity gate as if Sphere did
    const gateFn = vi.fn(() => 'down' as const);
    (module as any).configureConnectivityGate(gateFn);
    // Spy on the first downstream call inside send() after the gate —
    // `maybeEmitCapabilityWarning` is the first inner method invoked.
    // If the gate works correctly, this MUST NOT be called.
    const downstreamSpy = vi.spyOn(module as any, 'maybeEmitCapabilityWarning' as any).mockImplementation(() => {
      throw new Error('maybeEmitCapabilityWarning should not have been called');
    });
    let caught: unknown;
    try {
      await module.send(REQUEST);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(isSphereError(caught)).toBe(true);
    expect((caught as any).code).toBe('OFFLINE');
    // SphereError redaction layer copies the cause object into `context`.
    expect((caught as any).context).toEqual({ which: 'aggregator' });
    // Gate was called once
    expect(gateFn).toHaveBeenCalledTimes(1);
    // No downstream side effect
    expect(downstreamSpy).not.toHaveBeenCalled();
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
    (module as any).configureConnectivityGate(() => 'down' as const);
    // Confirm it gates first
    await expect(module.send(REQUEST)).rejects.toThrow(/offline/i);
    // Now unwire
    (module as any).configureConnectivityGate(null);
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
});
