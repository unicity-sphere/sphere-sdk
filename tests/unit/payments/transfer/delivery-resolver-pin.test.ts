/**
 * OUTBOX-SEND-FOLLOWUPS Item #6.a — IPFS pin signal on inline-CAR
 * delivery decisions.
 *
 * Pins the `shouldPin` field contract on the `DeliveryDecision`'s
 * inline shape. When a `publishToIpfs` callback is wired on the
 * resolver call, every inline-returning branch (force-inline, auto-
 * inline, auto-CID-fallback-to-inline-when-no-publisher) MUST signal
 * whether the orchestrator should additionally pin the same content-
 * addressed CAR bytes for Item #2 retention re-publish durability.
 *
 * The actual pin call is fire-and-forget at the orchestrator layer
 * (conservative-sender / instant-sender) — this file does NOT exercise
 * the I/O; it pins the resolver's pure decision-function contract.
 *
 * Sibling: `delivery-resolver.test.ts` — covers the inline/CID branch
 * decision logic itself. This file extends the same surface with the
 * `shouldPin` overlay.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  resolveDelivery,
  type PublishToIpfsCallback,
  type PublishToIpfsResult,
} from '../../../../modules/payments/transfer/delivery-resolver';
import {
  AUTOMATED_CID_DELIVERY_ENABLED,
  MAX_INLINE_CAR_BYTES,
  RELAY_SAFE_CAP_BYTES,
} from '../../../../modules/payments/transfer/limits';
// Issue #393 — gate auto-CID-promotion tests on the kill-switch.
const ifAutoCid = AUTOMATED_CID_DELIVERY_ENABLED ? it : it.skip;

// =============================================================================
// Test helpers (kept local — slight duplication with delivery-resolver.test.ts
// is intentional to keep this file self-contained for the Item #6.a contract)
// =============================================================================

function makeCarBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (i * 31 + 7) & 0xff;
  }
  return out;
}

function mockPublisher(cid: string = 'bafytestfakecidv1example'): {
  fn: ReturnType<typeof vi.fn<(carBytes: Uint8Array) => Promise<PublishToIpfsResult>>>;
  callback: PublishToIpfsCallback;
} {
  const fn = vi.fn<(carBytes: Uint8Array) => Promise<PublishToIpfsResult>>(
    async (_bytes) => ({ cid }),
  );
  const callback: PublishToIpfsCallback = (carBytes) => fn(carBytes);
  return { fn, callback };
}

// =============================================================================
// 1. force-inline branch — Item #6.a pin signal
// =============================================================================

describe('resolveDelivery — Item #6.a pin signal on force-inline', () => {
  it('sets shouldPin: true when publishToIpfs is wired (small CAR)', async () => {
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher();
    const carBytes = makeCarBytes(10);
    const decision = await resolveDelivery({
      strategy: { kind: 'force-inline' },
      carBytes,
      publishToIpfs,
    });

    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      // Item #6.a contract: pin signal flipped on because publisher was wired.
      expect(decision.shouldPin).toBe(true);
    }
    // Resolver stays a pure decision function — publishToIpfs is NOT
    // called by the resolver itself even though shouldPin === true.
    // The orchestrator owns the fire-and-forget pin call.
    expect(publishFn).not.toHaveBeenCalled();
  });

  it('sets shouldPin: true at the RELAY_SAFE_CAP_BYTES boundary when publisher wired', async () => {
    const { callback: publishToIpfs } = mockPublisher();
    const carBytes = makeCarBytes(RELAY_SAFE_CAP_BYTES);
    const decision = await resolveDelivery({
      strategy: { kind: 'force-inline' },
      carBytes,
      publishToIpfs,
    });
    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      expect(decision.shouldPin).toBe(true);
    }
  });

  it('omits shouldPin when publishToIpfs is absent (no publisher → no pin signal)', async () => {
    const carBytes = makeCarBytes(10);
    const decision = await resolveDelivery({
      strategy: { kind: 'force-inline' },
      carBytes,
    });
    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      // No publisher wired → orchestrator has no means to pin, so the
      // resolver does NOT mislead it with a stale shouldPin flag.
      expect(decision.shouldPin).toBeUndefined();
    }
  });
});

// =============================================================================
// 2. auto-inline branch (bundle fits under cap) — Item #6.a pin signal
// =============================================================================

describe('resolveDelivery — Item #6.a pin signal on auto-inline (within cap)', () => {
  it('sets shouldPin: true when publisher wired and CAR fits in default cap', async () => {
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher();
    const carBytes = makeCarBytes(MAX_INLINE_CAR_BYTES);
    const decision = await resolveDelivery({
      strategy: { kind: 'auto' },
      carBytes,
      publishToIpfs,
    });

    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      expect(decision.shouldPin).toBe(true);
      // The auto-mode inline branch also surfaces clampInfo — it must
      // coexist with shouldPin on the same shape.
      expect(decision.clampInfo).toBeDefined();
    }
    expect(publishFn).not.toHaveBeenCalled();
  });

  it('sets shouldPin: true with a custom in-range cap (1024 bytes)', async () => {
    const { callback: publishToIpfs } = mockPublisher();
    const carBytes = makeCarBytes(1023);
    const decision = await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: 1024 },
      carBytes,
      publishToIpfs,
    });
    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      expect(decision.shouldPin).toBe(true);
      expect(decision.clampInfo?.effectiveCap).toBe(1024);
      expect(decision.clampInfo?.reason).toBe('ok');
    }
  });

  it('omits shouldPin when publisher absent (auto-inline within cap)', async () => {
    const carBytes = makeCarBytes(MAX_INLINE_CAR_BYTES);
    const decision = await resolveDelivery({
      strategy: { kind: 'auto' },
      carBytes,
    });
    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      expect(decision.shouldPin).toBeUndefined();
      // clampInfo still present — the two fields are independent.
      expect(decision.clampInfo).toBeDefined();
    }
  });
});

// =============================================================================
// 3. carInlineFallback — Item #6.a contract for the no-publisher branch
// =============================================================================

describe('resolveDelivery — Item #6.a pin signal on auto CAR-inline fallback', () => {
  it('omits shouldPin on the auto-CID-fallback-to-inline branch (publisher absent by construction)', async () => {
    // auto + bundle over MAX_INLINE_CAR_BYTES + no publisher → falls
    // back to inline as long as the bundle fits in RELAY_SAFE_CAP_BYTES.
    // The fallback path is reached BECAUSE the publisher is missing, so
    // there is no orchestrator-side pin signal to surface.
    const carBytes = makeCarBytes(MAX_INLINE_CAR_BYTES + 1);
    const decision = await resolveDelivery({
      strategy: { kind: 'auto' },
      carBytes,
      // publishToIpfs intentionally omitted — exercises the fallback.
    });
    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      // No publisher wired → no pin signal. Orchestrator must NOT try
      // to pin from this branch (it would crash on undefined callback).
      expect(decision.shouldPin).toBeUndefined();
    }
  });

  it('omits shouldPin at the RELAY_SAFE_CAP_BYTES boundary fallback', async () => {
    const carBytes = makeCarBytes(RELAY_SAFE_CAP_BYTES);
    const decision = await resolveDelivery({
      strategy: { kind: 'auto' },
      carBytes,
    });
    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      expect(decision.shouldPin).toBeUndefined();
    }
  });
});

// =============================================================================
// 4. CID branches — shouldPin: true on its CID shape is unchanged by Item #6.a
// =============================================================================

describe('resolveDelivery — CID branches preserve existing shouldPin: true contract', () => {
  it('force-cid still returns CID with shouldPin: true (Item #6.a does not touch this branch)', async () => {
    const { callback: publishToIpfs } = mockPublisher();
    const decision = await resolveDelivery({
      strategy: { kind: 'force-cid' },
      carBytes: makeCarBytes(1),
      publishToIpfs,
    });
    expect(decision.kind).toBe('cid');
    if (decision.kind === 'cid') {
      expect(decision.shouldPin).toBe(true);
    }
  });

  ifAutoCid('auto-over-cap with publisher still returns CID with shouldPin: true', async () => {
    const { callback: publishToIpfs } = mockPublisher();
    const decision = await resolveDelivery({
      strategy: { kind: 'auto' },
      carBytes: makeCarBytes(MAX_INLINE_CAR_BYTES + 1),
      publishToIpfs,
    });
    expect(decision.kind).toBe('cid');
    if (decision.kind === 'cid') {
      expect(decision.shouldPin).toBe(true);
    }
  });
});

// =============================================================================
// 5. Resolver purity — no I/O fired even when shouldPin is set
// =============================================================================

describe('resolveDelivery — Item #6.a preserves resolver purity', () => {
  it('does NOT call publishToIpfs on any inline branch (orchestrator owns the pin)', async () => {
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher();

    // force-inline + publisher
    await resolveDelivery({
      strategy: { kind: 'force-inline' },
      carBytes: makeCarBytes(10),
      publishToIpfs,
    });
    // auto-inline + publisher
    await resolveDelivery({
      strategy: { kind: 'auto' },
      carBytes: makeCarBytes(100),
      publishToIpfs,
    });

    // The resolver must NOT fire pin calls for inline decisions even
    // though shouldPin is set — that's the orchestrator's job (fire-
    // and-forget at conservative-sender / instant-sender).
    expect(publishFn).not.toHaveBeenCalled();
  });
});
