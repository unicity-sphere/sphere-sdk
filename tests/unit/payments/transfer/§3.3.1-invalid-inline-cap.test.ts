/**
 * §3.3.1 — Deterministic INVALID_INLINE_CAP rejection vs silent clamp (W12).
 *
 * The spec's §3.3.1 normative paragraph reads (paraphrased): if the caller
 * passes `inlineCapBytes: N` with `N > 96 KiB`, the SDK MUST silently clamp;
 * implementations MAY instead deterministically reject undersized caps with
 * `INVALID_INLINE_CAP`. The choice between clamp and reject MUST be
 * deterministic.
 *
 * This SDK chooses:
 *  - **Reject** for `N < 1` (incl. `0`, negative, NaN, ±Infinity).
 *  - **Silent clamp + telemetry** for `N > RELAY_SAFE_CAP_BYTES` (96 KiB).
 *
 * The two branches MUST never blur. A test asserting that NaN throws
 * (rather than clamps) is the load-bearing W12 invariant — auditors checking
 * the implementation's deterministic choice rely on it.
 *
 * Spec references: §3.3.1 (the rejection-vs-clamp paragraph), W12 in
 * `UXF-TRANSFER-IMPL-PLAN.md`.
 */

import { describe, it, expect } from 'vitest';

import { resolveDelivery } from '../../../../modules/payments/transfer/delivery-resolver';
import {
  AUTOMATED_CID_DELIVERY_ENABLED,
  RELAY_SAFE_CAP_BYTES,
} from '../../../../modules/payments/transfer/limits';
import { SphereError } from '../../../../core/errors';

// =============================================================================
// Test helpers
// =============================================================================

const minimalCar = new Uint8Array([0xab, 0xcd]);

const noopPublisher = async (): Promise<{ cid: string }> => ({
  cid: 'bafyshouldnothavebeencalled',
});

// =============================================================================
// 1. Undersized caps — DETERMINISTIC REJECT
// =============================================================================

describe('§3.3.1 INVALID_INLINE_CAP — undersized cap rejects deterministically', () => {
  it('inlineCapBytes: 0 → throws INVALID_INLINE_CAP', async () => {
    await expect(
      resolveDelivery({
        strategy: { kind: 'auto', inlineCapBytes: 0 },
        carBytes: minimalCar,
        publishToIpfs: noopPublisher,
      }),
    ).rejects.toMatchObject({
      name: 'SphereError',
      code: 'INVALID_INLINE_CAP',
    });
  });

  it('inlineCapBytes: -1 → throws INVALID_INLINE_CAP', async () => {
    await expect(
      resolveDelivery({
        strategy: { kind: 'auto', inlineCapBytes: -1 },
        carBytes: minimalCar,
        publishToIpfs: noopPublisher,
      }),
    ).rejects.toMatchObject({
      name: 'SphereError',
      code: 'INVALID_INLINE_CAP',
    });
  });

  it('inlineCapBytes: -5 → throws INVALID_INLINE_CAP', async () => {
    await expect(
      resolveDelivery({
        strategy: { kind: 'auto', inlineCapBytes: -5 },
        carBytes: minimalCar,
        publishToIpfs: noopPublisher,
      }),
    ).rejects.toBeInstanceOf(SphereError);
  });

  it('inlineCapBytes: 0.5 (< 1, fractional) → throws INVALID_INLINE_CAP', async () => {
    // Boundary check on the strict `< 1` rule. 0.5 is finite but < 1, so
    // it MUST reject. (The spec's wording is "cap < 1", not "cap < 0".)
    await expect(
      resolveDelivery({
        strategy: { kind: 'auto', inlineCapBytes: 0.5 },
        carBytes: minimalCar,
        publishToIpfs: noopPublisher,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INLINE_CAP',
    });
  });

  it('inlineCapBytes: NaN → throws INVALID_INLINE_CAP (deterministic)', async () => {
    // Critical W12 invariant: NaN is non-finite, classified as undersized,
    // and MUST trip the deterministic reject branch — NOT the silent clamp.
    // The naive bug would be using `n > 96 * 1024` to detect oversized
    // (false for NaN) AND `n < 1` to detect undersized (also false for
    // NaN), letting NaN slip through to `clampInlineCap` which would coerce
    // it to 1 (`reason: 'below-min'`). We avoid that by checking
    // `!Number.isFinite(n) || n < 1` together.
    await expect(
      resolveDelivery({
        strategy: { kind: 'auto', inlineCapBytes: Number.NaN },
        carBytes: minimalCar,
        publishToIpfs: noopPublisher,
      }),
    ).rejects.toMatchObject({
      name: 'SphereError',
      code: 'INVALID_INLINE_CAP',
    });
  });

  it('inlineCapBytes: -Infinity → throws INVALID_INLINE_CAP', async () => {
    await expect(
      resolveDelivery({
        strategy: { kind: 'auto', inlineCapBytes: Number.NEGATIVE_INFINITY },
        carBytes: minimalCar,
        publishToIpfs: noopPublisher,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INLINE_CAP',
    });
  });

  it('inlineCapBytes: +Infinity → throws INVALID_INLINE_CAP (non-finite)', async () => {
    // +Infinity is technically "above the relay-safe cap" by magnitude,
    // BUT it is non-finite. Our deterministic-reject rule catches it via
    // the `!Number.isFinite()` check; it MUST throw, not clamp. Auditors
    // depend on this: `+Infinity` is conceptually malformed input, not a
    // request to use the maximum cap.
    await expect(
      resolveDelivery({
        strategy: { kind: 'auto', inlineCapBytes: Number.POSITIVE_INFINITY },
        carBytes: minimalCar,
        publishToIpfs: noopPublisher,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_INLINE_CAP',
    });
  });
});

// =============================================================================
// 2. In-range cap — NO throw, NO clamp
// =============================================================================

describe('§3.3.1 INVALID_INLINE_CAP — in-range caps pass through', () => {
  it('inlineCapBytes: 1 (the minimum legal value) → no throw', async () => {
    // 1 is the minimum legal value (the boundary). Critical: it must NOT
    // throw INVALID_INLINE_CAP (cap = 1 is legal, not "< 1").
    //
    // **Issue #393 — kill-switch dependent outcome.**
    //  - When AUTOMATED_CID_DELIVERY_ENABLED === true (legacy behaviour):
    //    the CAR (2 bytes) exceeds the 1-byte cap, so the resolver
    //    promotes to CID.
    //  - When AUTOMATED_CID_DELIVERY_ENABLED === false (current default):
    //    auto-mode never promotes, so the routing stays inline. The
    //    no-throw assertion still holds — that's the load-bearing
    //    contract this test pins.
    const result = await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: 1 },
      carBytes: minimalCar,
      publishToIpfs: async () => ({ cid: 'bafyok' }),
    });
    expect(result.kind).toBe(AUTOMATED_CID_DELIVERY_ENABLED ? 'cid' : 'inline');
  });

  it('inlineCapBytes: 16384 (default) → no throw, inline path, no clamp', async () => {
    const result = await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: 16384 },
      carBytes: minimalCar,
      publishToIpfs: noopPublisher,
    });
    expect(result.kind).toBe('inline');
    if (result.kind === 'inline') {
      expect(result.clampInfo).toEqual({
        originalCap: 16384,
        effectiveCap: 16384,
        reason: 'ok',
      });
    }
  });

  it('inlineCapBytes: 96 KiB (the exact ceiling) → no throw, no clamp', async () => {
    // The boundary value: at the ceiling, no clamp (clamp fires for `>`).
    const result = await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: RELAY_SAFE_CAP_BYTES },
      carBytes: minimalCar,
      publishToIpfs: noopPublisher,
    });
    expect(result.kind).toBe('inline');
    if (result.kind === 'inline') {
      expect(result.clampInfo?.reason).toBe('ok');
    }
  });
});

// =============================================================================
// 3. Oversized cap — SILENT CLAMP + TELEMETRY (the OTHER deterministic choice)
// =============================================================================

describe('§3.3.1 INVALID_INLINE_CAP — oversized cap silently clamps (does NOT throw)', () => {
  it('inlineCapBytes: 200000 (> 96 KiB) → silent clamp + telemetry, NO throw', async () => {
    // The dual case to the undersized-reject branch: oversized values are
    // CLAMPED, not rejected. This contrast is the heart of W12 — without
    // this asymmetry, callers couldn't tell which behavior they're getting
    // for a given out-of-range input. The deterministic spec is:
    //   - undersized → throw INVALID_INLINE_CAP
    //   - oversized  → silent clamp to RELAY_SAFE_CAP_BYTES + telemetry
    let telemetryFired = 0;
    const result = await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: 200_000 },
      carBytes: minimalCar,
      publishToIpfs: noopPublisher,
      emitTelemetry: () => {
        telemetryFired++;
      },
    });

    // Decision: inline (CAR is 2 bytes, well under the clamped 96 KiB).
    expect(result.kind).toBe('inline');
    if (result.kind === 'inline') {
      expect(result.clampInfo).toEqual({
        originalCap: 200_000,
        effectiveCap: RELAY_SAFE_CAP_BYTES,
        reason: 'above-relay-cap',
      });
    }

    // Telemetry fired exactly once.
    expect(telemetryFired).toBe(1);
  });

  it('inlineCapBytes: 1 MiB → silent clamp + telemetry', async () => {
    let telemetryFired = 0;
    await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: 1024 * 1024 },
      carBytes: minimalCar,
      publishToIpfs: noopPublisher,
      emitTelemetry: () => {
        telemetryFired++;
      },
    });
    expect(telemetryFired).toBe(1);
  });

  it('Number.MAX_SAFE_INTEGER → silent clamp + telemetry, NOT rejection', async () => {
    // A finite-but-absurdly-large value MUST clamp, not reject. This
    // distinguishes the rule from "any pathological input → reject".
    let telemetryFired = 0;
    const result = await resolveDelivery({
      strategy: { kind: 'auto', inlineCapBytes: Number.MAX_SAFE_INTEGER },
      carBytes: minimalCar,
      publishToIpfs: noopPublisher,
      emitTelemetry: () => {
        telemetryFired++;
      },
    });
    expect(result.kind).toBe('inline');
    expect(telemetryFired).toBe(1);
  });
});

// =============================================================================
// 4. Confirm that omitting inlineCapBytes does NOT trip the reject branch
// =============================================================================

describe('§3.3.1 INVALID_INLINE_CAP — omitting cap uses default, does not throw', () => {
  it('strategy = { kind: "auto" } (no inlineCapBytes) → uses 16 KiB default, reason "default"', async () => {
    const result = await resolveDelivery({
      strategy: { kind: 'auto' },
      carBytes: minimalCar,
      publishToIpfs: noopPublisher,
    });
    expect(result.kind).toBe('inline');
    if (result.kind === 'inline') {
      expect(result.clampInfo?.reason).toBe('default');
    }
  });
});
