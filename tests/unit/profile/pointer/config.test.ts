/**
 * config.ts (T-D5, T-E26) — capability gates.
 *
 * Covers:
 *   - allowUnverifiedOverride=true + NODE_ENV=production → CAPABILITY_DENIED
 *   - allowUnverifiedOverride=true + NODE_ENV=development → permitted
 *   - allowOperatorOverrides=true + SPHERE_ALLOW_OVERRIDES unset → CAPABILITY_DENIED
 *   - allowOperatorOverrides=true + SPHERE_ALLOW_OVERRIDES=1 → permitted
 *   - assertOperatorOverridesAllowed throws when flag is false
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  assertConfigCapabilities,
  assertOperatorOverridesAllowed,
  operatorOverridesAllowed,
  AggregatorPointerErrorCode,
} from '../../../../profile/aggregator-pointer/index.js';

// Save and restore env vars across tests.
const originalNodeEnv = process.env.NODE_ENV;
const originalAllowOverrides = process.env.SPHERE_ALLOW_OVERRIDES;

beforeEach(() => {
  // Start each test with no overrides set.
  delete process.env.NODE_ENV;
  delete process.env.SPHERE_ALLOW_OVERRIDES;
});

afterEach(() => {
  if (originalNodeEnv !== undefined) process.env.NODE_ENV = originalNodeEnv;
  else delete process.env.NODE_ENV;
  if (originalAllowOverrides !== undefined) process.env.SPHERE_ALLOW_OVERRIDES = originalAllowOverrides;
  else delete process.env.SPHERE_ALLOW_OVERRIDES;
});

describe('assertConfigCapabilities — allowUnverifiedOverride (T-E26)', () => {
  it('CAPABILITY_DENIED when allowUnverifiedOverride=true and NODE_ENV unset', () => {
    expect(() => assertConfigCapabilities({ allowUnverifiedOverride: true })).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.CAPABILITY_DENIED }),
    );
  });

  it('CAPABILITY_DENIED when allowUnverifiedOverride=true and NODE_ENV=production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertConfigCapabilities({ allowUnverifiedOverride: true })).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.CAPABILITY_DENIED }),
    );
  });

  it('permitted when allowUnverifiedOverride=true and NODE_ENV=development', () => {
    process.env.NODE_ENV = 'development';
    expect(() => assertConfigCapabilities({ allowUnverifiedOverride: true })).not.toThrow();
  });

  it('permitted when allowUnverifiedOverride is omitted', () => {
    process.env.NODE_ENV = 'production';
    expect(() => assertConfigCapabilities({})).not.toThrow();
  });
});

describe('assertConfigCapabilities — allowOperatorOverrides', () => {
  it('CAPABILITY_DENIED when allowOperatorOverrides=true and env unset', () => {
    expect(() => assertConfigCapabilities({ allowOperatorOverrides: true })).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.CAPABILITY_DENIED }),
    );
  });

  it('permitted when allowOperatorOverrides=true and SPHERE_ALLOW_OVERRIDES=1', () => {
    process.env.SPHERE_ALLOW_OVERRIDES = '1';
    expect(() => assertConfigCapabilities({ allowOperatorOverrides: true })).not.toThrow();
  });

  it('CAPABILITY_DENIED when SPHERE_ALLOW_OVERRIDES has wrong value', () => {
    process.env.SPHERE_ALLOW_OVERRIDES = 'yes';
    expect(() => assertConfigCapabilities({ allowOperatorOverrides: true })).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.CAPABILITY_DENIED }),
    );
  });

  it('T-E26 production-build guard: CAPABILITY_DENIED when NODE_ENV=production even with SPHERE_ALLOW_OVERRIDES=1', () => {
    // Production builds cannot enable operator overrides regardless
    // of env var. The error message must reference NODE_ENV so the
    // operator understands why the otherwise-correct env override
    // was rejected.
    process.env.NODE_ENV = 'production';
    process.env.SPHERE_ALLOW_OVERRIDES = '1';
    expect(() => assertConfigCapabilities({ allowOperatorOverrides: true })).toThrow(
      expect.objectContaining({
        code: AggregatorPointerErrorCode.CAPABILITY_DENIED,
        message: expect.stringContaining('NODE_ENV=production'),
      }),
    );
  });

  it('permitted when NODE_ENV=staging + SPHERE_ALLOW_OVERRIDES=1', () => {
    // Production guard is strict on 'production' only; any other
    // value (staging, test, canary, unset) passes.
    process.env.NODE_ENV = 'staging';
    process.env.SPHERE_ALLOW_OVERRIDES = '1';
    expect(() => assertConfigCapabilities({ allowOperatorOverrides: true })).not.toThrow();
  });

  it('T-E26 case-insensitive: CAPABILITY_DENIED when NODE_ENV=PRODUCTION (uppercase)', () => {
    // A misconfigured CI or Windows env can deliver the string in a
    // non-canonical case. The guard must normalize before comparing
    // to prevent a trivial bypass.
    process.env.NODE_ENV = 'PRODUCTION';
    process.env.SPHERE_ALLOW_OVERRIDES = '1';
    expect(() => assertConfigCapabilities({ allowOperatorOverrides: true })).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.CAPABILITY_DENIED }),
    );
  });

  it('T-E26 case-insensitive: CAPABILITY_DENIED when NODE_ENV=Production (mixed case)', () => {
    process.env.NODE_ENV = 'Production';
    process.env.SPHERE_ALLOW_OVERRIDES = '1';
    expect(() => assertConfigCapabilities({ allowOperatorOverrides: true })).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.CAPABILITY_DENIED }),
    );
  });
});

describe('operatorOverridesAllowed + assertOperatorOverridesAllowed', () => {
  it('false by default', () => {
    expect(operatorOverridesAllowed({})).toBe(false);
  });

  it('true when flag set to true', () => {
    expect(operatorOverridesAllowed({ allowOperatorOverrides: true })).toBe(true);
  });

  it('assertOperatorOverridesAllowed throws when disabled', () => {
    expect(() => assertOperatorOverridesAllowed({}, 'acceptCarLoss')).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.CAPABILITY_DENIED }),
    );
  });

  it('assertOperatorOverridesAllowed passes when enabled', () => {
    expect(() =>
      assertOperatorOverridesAllowed({ allowOperatorOverrides: true }, 'clearBlocked'),
    ).not.toThrow();
  });

  it('error message includes the apiName', () => {
    try {
      assertOperatorOverridesAllowed({}, 'clearPendingMarker');
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('clearPendingMarker');
    }
  });
});
