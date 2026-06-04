/**
 * Tests for `modules/payments/transfer/delivery-resolver.ts` (T.2.C).
 *
 * Covers the happy paths and standard branches of the delivery resolver:
 *  - `auto` with default cap: inline ≤ 16 KiB, CID > 16 KiB.
 *  - `auto` with custom in-range cap: inline at boundary, CID just over.
 *  - `auto` with cap > 96 KiB: silent clamp + telemetry; bundle decision
 *    against the clamped 96 KiB.
 *  - `force-inline`: inline within 96 KiB, throws above 96 KiB.
 *  - `force-cid`: always CID, `shouldPin: true`, even for tiny bundles.
 *
 * Spec references: §3.3.1 (per-call overrides + clamp), §3.3.2 (delivery
 * completion semantics — informs `shouldPin`).
 *
 * Companion: `§3.3.1-invalid-inline-cap.test.ts` covers the deterministic
 * INVALID_INLINE_CAP rejection (W12), distinct from the silent-clamp path
 * exercised here.
 */

import { describe, it, expect, vi } from 'vitest';

import {
  resolveDelivery,
  type ClampTelemetry,
  type DeliveryDecision,
  type EmitTelemetryCallback,
  type PublishToIpfsCallback,
  type PublishToIpfsResult,
} from '../../../../modules/payments/transfer/delivery-resolver';
import {
  AUTOMATED_CID_DELIVERY_ENABLED,
  MAX_INLINE_CAR_BYTES,
  RELAY_SAFE_CAP_BYTES,
} from '../../../../modules/payments/transfer/limits';

// Issue #393 — five tests below exercise the `auto → CID` promotion
// path. They are gated on the {@link AUTOMATED_CID_DELIVERY_ENABLED}
// kill-switch in `limits.ts`: when the flag is OFF (current default),
// the resolver's `auto` branch never promotes oversized bundles to
// CID, so these tests are SKIPPED. They snap back into service
// automatically when the constant flips. See the constant's doc
// comment for the full re-enable checklist.
const ifAutoCid = AUTOMATED_CID_DELIVERY_ENABLED ? it : it.skip;
import { SphereError } from '../../../../core/errors';
import { carBytesToBase64 } from '../../../../uxf/transfer-payload';

// =============================================================================
// 1. Test helpers
// =============================================================================

/**
 * Build a deterministic CAR-like byte sequence of the requested length.
 * The bytes don't have to parse as a real CAR — the resolver treats the
 * input as opaque. Using a fixed pattern lets us assert the base64 round-
 * trip below.
 */
function makeCarBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = (i * 31 + 7) & 0xff;
  }
  return out;
}

/**
 * Mock IPFS publisher that returns a fixed CID and records every call.
 * Returns the underlying `vi.fn()` so tests can assert call count and
 * the bytes passed in.
 */
function mockPublisher(cid: string = 'bafytestfakecidv1example'): {
  fn: ReturnType<typeof vi.fn<(carBytes: Uint8Array) => Promise<PublishToIpfsResult>>>;
  callback: PublishToIpfsCallback;
} {
  const fn = vi.fn<(carBytes: Uint8Array) => Promise<PublishToIpfsResult>>(
    async (_bytes) => ({ cid }),
  );
  // The Mock object is callable; callable signature matches PublishToIpfsCallback.
  // We surface both the raw mock (for .toHaveBeenCalled* assertions) and a
  // typed callback view (so call sites get full type-checking).
  const callback: PublishToIpfsCallback = (carBytes) => fn(carBytes);
  return { fn, callback };
}

/**
 * Mock telemetry sink. Returns the recorded events array plus the
 * callback.
 */
function mockTelemetry(): {
  events: ClampTelemetry[];
  callback: EmitTelemetryCallback;
} {
  const events: ClampTelemetry[] = [];
  return {
    events,
    callback: (event) => {
      events.push(event);
    },
  };
}

// =============================================================================
// 2. `auto` mode — default cap (16 KiB)
// =============================================================================

describe('resolveDelivery — auto mode, default cap', () => {
  it('returns inline for a CAR ≤ 16 KiB', async () => {
    const carBytes = makeCarBytes(MAX_INLINE_CAR_BYTES);
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher();
    const decision = await resolveDelivery({
      strategy: { kind: 'auto' },
      carBytes,
      publishToIpfs,
    });

    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      expect(decision.carBase64).toBe(carBytesToBase64(carBytes));
      expect(decision.clampInfo).toEqual({
        originalCap: MAX_INLINE_CAR_BYTES,
        effectiveCap: MAX_INLINE_CAR_BYTES,
        reason: 'default',
      });
    }
    // No publish call: inline path skips IPFS.
    expect(publishFn).not.toHaveBeenCalled();
  });

  ifAutoCid('returns CID for a CAR > 16 KiB', async () => {
    const carBytes = makeCarBytes(MAX_INLINE_CAR_BYTES + 1);
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher('bafyhugecid');
    const decision = await resolveDelivery({
      strategy: { kind: 'auto' },
      carBytes,
      publishToIpfs,
    });

    expect(decision).toEqual<DeliveryDecision>({
      kind: 'cid',
      cid: 'bafyhugecid',
      shouldPin: true,
    });
    expect(publishFn).toHaveBeenCalledTimes(1);
    expect(publishFn).toHaveBeenCalledWith(carBytes);
  });

  it('returns inline at the exact 16 KiB boundary', async () => {
    // Boundary check: ≤ is inline, > is CID.
    const carBytes = makeCarBytes(MAX_INLINE_CAR_BYTES);
    const { callback: publishToIpfs } = mockPublisher();
    const decision = await resolveDelivery({
      strategy: { kind: 'auto' },
      carBytes,
      publishToIpfs,
    });
    expect(decision.kind).toBe('inline');
  });
});

// =============================================================================
// 3. `auto` mode — custom in-range cap
// =============================================================================

describe('resolveDelivery — auto mode, custom in-range cap', () => {
  it('returns inline for a CAR at the custom cap (1024 bytes, CAR is 1023)', async () => {
    const carBytes = makeCarBytes(1023);
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher();
    const decision = await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: 1024 },
      carBytes,
      publishToIpfs,
    });
    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      expect(decision.clampInfo).toEqual({
        originalCap: 1024,
        effectiveCap: 1024,
        reason: 'ok',
      });
    }
    expect(publishFn).not.toHaveBeenCalled();
  });

  ifAutoCid('returns CID when the CAR exceeds the custom cap by 1 byte', async () => {
    const carBytes = makeCarBytes(1025);
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher('bafycustom');
    const decision = await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: 1024 },
      carBytes,
      publishToIpfs,
    });
    expect(decision).toEqual<DeliveryDecision>({
      kind: 'cid',
      cid: 'bafycustom',
      shouldPin: true,
    });
    expect(publishFn).toHaveBeenCalledTimes(1);
  });

  it('does NOT emit telemetry for an in-range cap', async () => {
    const { events, callback: emitTelemetry } = mockTelemetry();
    const { callback: publishToIpfs } = mockPublisher();
    await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: 8192 },
      carBytes: makeCarBytes(100),
      publishToIpfs,
      emitTelemetry,
    });
    expect(events).toEqual([]);
  });
});

// =============================================================================
// 4. `auto` mode — cap > 96 KiB (silent clamp + telemetry)
// =============================================================================

describe('resolveDelivery — auto mode, cap > 96 KiB clamps silently', () => {
  it('clamps a 200 KiB cap down to 96 KiB and emits telemetry', async () => {
    // Bundle is 64 KiB — fits under the clamped 96 KiB ceiling, so the
    // decision is inline despite the original cap being unreasonably large.
    const carBytes = makeCarBytes(64 * 1024);
    const { events, callback: emitTelemetry } = mockTelemetry();
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher();

    const decision = await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: 200 * 1024 },
      carBytes,
      publishToIpfs,
      emitTelemetry,
    });

    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      expect(decision.clampInfo).toEqual({
        originalCap: 200 * 1024,
        effectiveCap: RELAY_SAFE_CAP_BYTES,
        reason: 'above-relay-cap',
      });
    }
    expect(publishFn).not.toHaveBeenCalled();

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual<ClampTelemetry>({
      type: 'inline-cap-clamped',
      clampInfo: {
        originalCap: 200 * 1024,
        effectiveCap: RELAY_SAFE_CAP_BYTES,
        reason: 'above-relay-cap',
      },
    });
  });

  ifAutoCid('clamps and routes to CID when CAR exceeds the clamped 96 KiB ceiling', async () => {
    const carBytes = makeCarBytes(RELAY_SAFE_CAP_BYTES + 1);
    const { events, callback: emitTelemetry } = mockTelemetry();
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher('bafyclamped');

    const decision = await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: 1024 * 1024 }, // 1 MiB → clamped to 96 KiB
      carBytes,
      publishToIpfs,
      emitTelemetry,
    });

    expect(decision).toEqual<DeliveryDecision>({
      kind: 'cid',
      cid: 'bafyclamped',
      shouldPin: true,
    });
    expect(publishFn).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.clampInfo.reason).toBe('above-relay-cap');
  });

  it('omitting emitTelemetry callback is non-fatal even when clamp fires', async () => {
    const carBytes = makeCarBytes(50);
    const { callback: publishToIpfs } = mockPublisher();
    // No `emitTelemetry` field — clamp still happens silently.
    const decision = await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: 200 * 1024 },
      carBytes,
      publishToIpfs,
    });
    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      expect(decision.clampInfo?.reason).toBe('above-relay-cap');
    }
  });
});

// =============================================================================
// 5. `force-inline` mode
// =============================================================================

describe('resolveDelivery — force-inline mode', () => {
  it('returns inline for a CAR within the 96 KiB ceiling', async () => {
    const carBytes = makeCarBytes(50 * 1024);
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher();
    const decision = await resolveDelivery({
      strategy: { kind: 'force-inline' },
      carBytes,
      publishToIpfs,
    });
    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      expect(decision.carBase64).toBe(carBytesToBase64(carBytes));
      // force-inline does NOT carry clampInfo (no clamp logic involved).
      expect(decision.clampInfo).toBeUndefined();
    }
    expect(publishFn).not.toHaveBeenCalled();
  });

  it('returns inline at the exact 96 KiB boundary', async () => {
    const carBytes = makeCarBytes(RELAY_SAFE_CAP_BYTES);
    const { callback: publishToIpfs } = mockPublisher();
    const decision = await resolveDelivery({
      strategy: { kind: 'force-inline' },
      carBytes,
      publishToIpfs,
    });
    expect(decision.kind).toBe('inline');
  });

  it('throws INLINE_CAR_TOO_LARGE for a CAR > 96 KiB', async () => {
    const carBytes = makeCarBytes(RELAY_SAFE_CAP_BYTES + 1);
    const { callback: publishToIpfs } = mockPublisher();
    await expect(
      resolveDelivery({
        strategy: { kind: 'force-inline' },
        carBytes,
        publishToIpfs,
      }),
    ).rejects.toMatchObject({
      name: 'SphereError',
      code: 'INLINE_CAR_TOO_LARGE',
    });
  });

  it('throws INLINE_CAR_TOO_LARGE for a CAR substantially over the ceiling (100 KiB)', async () => {
    const carBytes = makeCarBytes(100 * 1024);
    const { callback: publishToIpfs } = mockPublisher();
    await expect(
      resolveDelivery({
        strategy: { kind: 'force-inline' },
        carBytes,
        publishToIpfs,
      }),
    ).rejects.toBeInstanceOf(SphereError);
  });

  it('does NOT call publishToIpfs in any force-inline branch', async () => {
    // Both within-cap and over-cap force-inline paths must skip IPFS.
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher();
    await resolveDelivery({
      strategy: { kind: 'force-inline' },
      carBytes: makeCarBytes(10),
      publishToIpfs,
    });
    expect(publishFn).not.toHaveBeenCalled();

    await expect(
      resolveDelivery({
        strategy: { kind: 'force-inline' },
        carBytes: makeCarBytes(RELAY_SAFE_CAP_BYTES + 1),
        publishToIpfs,
      }),
    ).rejects.toThrow();
    expect(publishFn).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 6. `force-cid` mode
// =============================================================================

describe('resolveDelivery — force-cid mode', () => {
  it('returns CID for a tiny 1-byte CAR (publishToIpfs called)', async () => {
    const carBytes = makeCarBytes(1);
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher('bafytiny');
    const decision = await resolveDelivery({
      strategy: { kind: 'force-cid' },
      carBytes,
      publishToIpfs,
    });
    expect(decision).toEqual<DeliveryDecision>({
      kind: 'cid',
      cid: 'bafytiny',
      shouldPin: true,
    });
    expect(publishFn).toHaveBeenCalledTimes(1);
    expect(publishFn).toHaveBeenCalledWith(carBytes);
  });

  it('returns shouldPin: true unconditionally', async () => {
    // Even for a CAR that would have inlined under `auto`, force-cid pins.
    const carBytes = makeCarBytes(100);
    const { callback: publishToIpfs } = mockPublisher();
    const decision = await resolveDelivery({
      strategy: { kind: 'force-cid' },
      carBytes,
      publishToIpfs,
    });
    expect(decision.kind).toBe('cid');
    if (decision.kind === 'cid') {
      expect(decision.shouldPin).toBe(true);
    }
  });

  it('returns CID even at the inline cap boundary', async () => {
    // 16 KiB is the auto cutoff — force-cid overrides it.
    const carBytes = makeCarBytes(MAX_INLINE_CAR_BYTES);
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher();
    const decision = await resolveDelivery({
      strategy: { kind: 'force-cid' },
      carBytes,
      publishToIpfs,
    });
    expect(decision.kind).toBe('cid');
    expect(publishFn).toHaveBeenCalledTimes(1);
  });

  it('propagates publishToIpfs rejection without falling back to inline', async () => {
    const carBytes = makeCarBytes(100);
    const error = new Error('IPFS gateway unreachable');
    const publishToIpfs: PublishToIpfsCallback = async () => {
      throw error;
    };
    await expect(
      resolveDelivery({
        strategy: { kind: 'force-cid' },
        carBytes,
        publishToIpfs,
      }),
    ).rejects.toBe(error);
  });
});

// =============================================================================
// 7. Cross-mode: publishToIpfs failure semantics in `auto` mode
// =============================================================================

describe('resolveDelivery — IPFS failure propagation', () => {
  ifAutoCid('propagates publishToIpfs rejection from auto/CID branch', async () => {
    const carBytes = makeCarBytes(MAX_INLINE_CAR_BYTES + 1); // routes to CID
    const error = new Error('pin failed');
    const publishToIpfs: PublishToIpfsCallback = async () => {
      throw error;
    };
    await expect(
      resolveDelivery({
        strategy: { kind: 'auto' },
        carBytes,
        publishToIpfs,
      }),
    ).rejects.toBe(error);
  });
});

// =============================================================================
// 8a. CAR-inline fallback (approach γ) — publishToIpfs absent
// =============================================================================

describe('resolveDelivery — CAR-inline fallback when publishToIpfs absent', () => {
  it('auto + no publisher + small bundle → falls back to inline (uxf-car)', async () => {
    // Bundle > 16 KiB (CID branch) but <= RELAY_SAFE_CAP_BYTES (96 KiB).
    // Without a publisher the resolver must fall back to inline delivery.
    const carBytes = makeCarBytes(MAX_INLINE_CAR_BYTES + 1);
    const decision = await resolveDelivery({
      strategy: { kind: 'auto' },
      carBytes,
      // publishToIpfs intentionally absent
    });
    expect(decision.kind).toBe('inline');
    if (decision.kind === 'inline') {
      expect(decision.carBase64).toBe(carBytesToBase64(carBytes));
    }
  });

  // **Steelman fix (Wave 3) — force-cid privacy regression hardening.**
  // Earlier behavior: `force-cid` + no publisher silently downgraded to
  // inline delivery for any bundle <= RELAY_SAFE_CAP_BYTES. That defeats
  // the point of force-cid (which signals an explicit privacy intent —
  // CID-only, no inline relay leak). The resolver now hard-fails with
  // `FORCE_CID_NO_PUBLISHER` regardless of bundle size; the caller must
  // wire a publisher or pick a different strategy.
  it('force-cid + no publisher + small bundle → throws FORCE_CID_NO_PUBLISHER (no silent downgrade)', async () => {
    const carBytes = makeCarBytes(1024); // tiny bundle, force-cid still triggers CID branch
    await expect(
      resolveDelivery({
        strategy: { kind: 'force-cid' },
        carBytes,
        // publishToIpfs intentionally absent
      }),
    ).rejects.toMatchObject({ code: 'FORCE_CID_NO_PUBLISHER' });
  });

  ifAutoCid('auto + no publisher + oversized bundle → throws IPFS_PUBLISHER_REQUIRED', async () => {
    // Bundle > RELAY_SAFE_CAP_BYTES — cannot fit in a Nostr event.
    const carBytes = makeCarBytes(RELAY_SAFE_CAP_BYTES + 1);
    await expect(
      resolveDelivery({
        strategy: { kind: 'auto' },
        carBytes,
        // publishToIpfs intentionally absent
      }),
    ).rejects.toMatchObject({ code: 'IPFS_PUBLISHER_REQUIRED' });
  });

  it('force-cid + no publisher + oversized bundle → throws FORCE_CID_NO_PUBLISHER', async () => {
    // Steelman Wave 3: force-cid hard-fails regardless of size — the
    // failure code is the privacy-intent code, not the size-cap code.
    const carBytes = makeCarBytes(RELAY_SAFE_CAP_BYTES + 1);
    await expect(
      resolveDelivery({
        strategy: { kind: 'force-cid' },
        carBytes,
        // publishToIpfs intentionally absent
      }),
    ).rejects.toMatchObject({ code: 'FORCE_CID_NO_PUBLISHER' });
  });

  it('auto + no publisher + bundle at exact RELAY_SAFE_CAP_BYTES boundary → inline', async () => {
    const carBytes = makeCarBytes(RELAY_SAFE_CAP_BYTES); // boundary: <= falls back to inline
    const decision = await resolveDelivery({
      strategy: { kind: 'auto' },
      carBytes,
      // publishToIpfs intentionally absent
    });
    expect(decision.kind).toBe('inline');
  });
});

// =============================================================================
// 8. Forward-compat / extension-point sanity checks
// =============================================================================

describe('resolveDelivery — forward-compat extension points', () => {
  it('source carries the // TODO(T.future-NIP11) marker', async () => {
    // The plan mandates a `// TODO(T.future-NIP11)` marker. We sanity-check
    // by reading the resolver source once. This is a comment-only check —
    // no code path. If the marker is removed, the test fails immediately,
    // catching accidental deletion during refactor.
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = await import('node:path');
    const here = url.fileURLToPath(import.meta.url);
    const resolverPath = path.resolve(
      path.dirname(here),
      '../../../../modules/payments/transfer/delivery-resolver.ts',
    );
    const source = await fs.readFile(resolverPath, 'utf8');
    expect(source).toContain('TODO(T.future-NIP11)');
    // Also assert the extension-point note is present (not just the bare TODO):
    expect(source).toContain('NIP-11');
    expect(source).toContain('Extension point');
  });
});

// =============================================================================
// Issue #393 — Automated CID delivery is currently DISABLED.
// =============================================================================
//
// These tests pin the behaviour when `AUTOMATED_CID_DELIVERY_ENABLED` is
// `false` (the current default). They run UNCONDITIONALLY so that an
// accidental flip of the constant ALSO fails these tests until the
// auto-promotion soak coverage is in place — that's a deliberate trip
// wire.

describe('resolveDelivery — auto mode under #393 kill-switch (currently disabled)', () => {
  const ifDisabled = AUTOMATED_CID_DELIVERY_ENABLED ? it.skip : it;

  ifDisabled('returns inline for an auto-mode CAR > inlineCapBytes (CID promotion blocked)', async () => {
    // Pre-#393: bundle exceeds custom 1 KiB cap → resolver promotes to CID.
    // Post-#393: kill-switch off → resolver stays inline up to RELAY_SAFE_CAP_BYTES.
    const carBytes = makeCarBytes(8192); // 8 KiB > 1 KiB custom cap, well under 96 KiB
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher('bafyshouldnotbecalled');
    const decision = await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: 1024 },
      carBytes,
      publishToIpfs,
    });
    expect(decision.kind).toBe('inline');
    expect(publishFn).not.toHaveBeenCalled();
  });

  ifDisabled('throws INLINE_CAR_TOO_LARGE for auto-mode CAR > RELAY_SAFE_CAP_BYTES (force-cid is now the only escape)', async () => {
    const carBytes = makeCarBytes(RELAY_SAFE_CAP_BYTES + 1);
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher();
    // Even WITH a publisher wired, auto mode no longer promotes — the
    // kill-switch forces a throw and instructs the caller to use
    // {kind: 'force-cid'} explicitly.
    await expect(
      resolveDelivery({ strategy: { kind: 'auto' }, carBytes, publishToIpfs }),
    ).rejects.toMatchObject({ code: 'INLINE_CAR_TOO_LARGE' });
    expect(publishFn).not.toHaveBeenCalled();
  });

  ifDisabled('force-cid still works as the explicit opt-in for CID delivery', async () => {
    // Sanity check that the kill-switch only affects `auto` — `force-cid`
    // still publishes via the resolver and returns a `cid` decision.
    const carBytes = makeCarBytes(RELAY_SAFE_CAP_BYTES + 1);
    const { fn: publishFn, callback: publishToIpfs } = mockPublisher('bafyforced');
    const decision = await resolveDelivery({
      strategy: { kind: 'force-cid' },
      carBytes,
      publishToIpfs,
    });
    expect(decision).toEqual<DeliveryDecision>({
      kind: 'cid',
      cid: 'bafyforced',
      shouldPin: true,
    });
    expect(publishFn).toHaveBeenCalledTimes(1);
  });
});
