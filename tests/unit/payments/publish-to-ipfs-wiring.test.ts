/**
 * Issue #200 Phase 1 wiring — PaymentsModule dependency-injection
 * contract for the canonical `publishToIpfs` callback.
 *
 * Before this wave, the conservative + instant dispatchers had two
 * `// publishToIpfs unwired` comment blocks that intentionally did NOT
 * forward any publisher to the underlying senders, leaving CID-bound
 * delivery dormant in production. This test pins the new contract:
 *
 *   `PaymentsModule.initialize({ ..., publishToIpfs })`
 *     ↓ (mechanical assignment, no transformation)
 *   `(module as any).deps.publishToIpfs === publishToIpfs`
 *
 * If a future refactor accidentally drops the field from
 * `PaymentsModuleDependencies` (or the dispatcher stops forwarding it
 * to `ConservativeSenderDeps` / `InstantSenderDeps`), this assertion
 * catches the regression at the wiring layer instead of waiting for the
 * end-to-end transfer test to fail.
 *
 * Companion tests:
 *  - `tests/unit/payments/transfer/ipfs-publisher.test.ts` — the
 *    canonical publisher factory's CID-correspondence contract.
 *  - `tests/integration/transfer/uxf-cid-canonical-publisher.test.ts` —
 *    end-to-end CID delivery via `sendConservativeUxf` with the
 *    canonical publisher and a stub gateway.
 *  - `tests/unit/impl/nodejs/providers-publish-to-ipfs.test.ts` — the
 *    provider-factory contract that builds the publisher from the
 *    resolved IPFS gateway list.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi } from 'vitest';

import { PaymentsModule } from '../../../modules/payments/PaymentsModule';
import type { PublishToIpfsCallback } from '../../../modules/payments/transfer/delivery-resolver';
import type { FullIdentity } from '../../../types';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Build a stub identity sufficient for `PaymentsModule.initialize`.
 * The module does not actually exercise the identity in this test — it
 * just needs the field non-null.
 */
function stubIdentity(): FullIdentity {
  return {
    chainPubkey: '02' + 'aa'.repeat(32),
    l1Address: 'alpha1test',
    directAddress: 'DIRECT://test',
    privateKey: 'bb'.repeat(32),
  };
}

/**
 * Build a stub `PaymentsModuleDependencies` value with only the fields
 * `initialize()` requires. All callback-like dependencies are noops.
 */
function stubDeps(publishToIpfs?: PublishToIpfsCallback) {
  return {
    identity: stubIdentity(),
    storage: {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      has: vi.fn(async () => false),
      list: vi.fn(async () => []),
      isConnected: () => true,
      connect: async () => undefined,
      disconnect: async () => undefined,
      setIdentity: () => undefined,
      clear: async () => undefined,
    } as any,
    transport: {
      resolve: vi.fn(async () => null),
      subscribe: vi.fn(() => () => undefined),
      onTokenTransfer: vi.fn(() => () => undefined),
      onPaymentRequest: vi.fn(() => () => undefined),
      onPaymentRequestResponse: vi.fn(() => () => undefined),
    } as any,
    oracle: {
      verifyToken: vi.fn(),
      submitTransaction: vi.fn(),
    } as any,
    emitEvent: vi.fn(),
    publishToIpfs,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('Issue #200 Phase 1 wiring — PaymentsModule.publishToIpfs', () => {
  it('captures the publisher callback by reference (no transformation)', () => {
    const module = new PaymentsModule({ features: { senderUxf: true } });
    const publisher: PublishToIpfsCallback = vi.fn(async () => ({
      cid: 'bafy-not-actually-pinned',
    }));

    module.initialize(stubDeps(publisher) as any);

    expect((module as any).deps.publishToIpfs).toBe(publisher);
  });

  it('captures undefined when no publisher is supplied (dormant CID delivery)', () => {
    const module = new PaymentsModule({ features: { senderUxf: true } });

    module.initialize(stubDeps(undefined) as any);

    expect((module as any).deps.publishToIpfs).toBeUndefined();
  });

  it('re-initialization replaces the publisher (per-address re-wire path)', () => {
    // Sphere.switchToAddress re-initializes PaymentsModule with a fresh
    // identity. The publisher MUST flow through the new deps so the
    // next address's send pipeline can pin too.
    const module = new PaymentsModule({ features: { senderUxf: true } });

    const firstPublisher: PublishToIpfsCallback = vi.fn(async () => ({
      cid: 'bafy-first',
    }));
    module.initialize(stubDeps(firstPublisher) as any);
    expect((module as any).deps.publishToIpfs).toBe(firstPublisher);

    const secondPublisher: PublishToIpfsCallback = vi.fn(async () => ({
      cid: 'bafy-second',
    }));
    module.initialize(stubDeps(secondPublisher) as any);
    expect((module as any).deps.publishToIpfs).toBe(secondPublisher);
    expect((module as any).deps.publishToIpfs).not.toBe(firstPublisher);
  });
});
