/**
 * Transfer Mode widening — narrowing shim tests (T.1.B.1).
 *
 * Covers the two pillars of the §T.1.B.1 acceptance:
 *  1. The runtime narrowing shim (`narrowTransferMode`,
 *     `assertConservativeOrInstant`, `coercePartialTransferRequestMode`)
 *     produces the documented {@link InternalTransferMode} values for the
 *     public {@link TransferMode} inputs and rejects `'txf'` (and any
 *     other unknown string smuggled in via a `TransferMode` cast) with
 *     the typed `UNSUPPORTED_TRANSFER_MODE` error.
 *  2. The compile-time TransferRequest widening — verified via a
 *     `satisfies` block that the seven new optional fields
 *     (`coinId?`, `amount?`, `additionalAssets?`, `allowPendingTokens?`,
 *     `confirmNftPending?`, `delivery?`, `txfFinalization?`) all type-check.
 *
 * Spec references: Plan §T.1.B.1 acceptance criteria (every bullet).
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  DEFAULT_TRANSFER_MODE,
  defaultTransferMode,
  narrowTransferMode,
  assertConservativeOrInstant,
  coercePartialTransferRequestMode,
} from '../../../modules/payments/transfer/transfer-mode-shims';
import { isSphereError, type SphereErrorCode } from '../../../core/errors';
import type {
  AdditionalAsset,
  AssetTarget,
  DeliveryStrategy,
  InternalTransferMode,
  TransferMode,
  TransferRequest,
} from '../../../types';
import { isCoinAsset, isNftAsset } from '../../../types/asset-target';

// ---------------------------------------------------------------------------
// Runtime narrowing — `narrowTransferMode`
// ---------------------------------------------------------------------------

describe('narrowTransferMode', () => {
  it('returns "instant" for the public "instant" value', () => {
    const out = narrowTransferMode('instant');
    expect(out).toBe('instant');
  });

  it('returns "conservative" for the public "conservative" value', () => {
    const out = narrowTransferMode('conservative');
    expect(out).toBe('conservative');
  });

  it('returns the SDK default ("instant") when called with `undefined`', () => {
    expect(narrowTransferMode(undefined)).toBe('instant');
    expect(DEFAULT_TRANSFER_MODE).toBe('instant');
    expect(defaultTransferMode()).toBe('instant');
  });

  it('rejects "txf" (only reachable via cast) with UNSUPPORTED_TRANSFER_MODE', () => {
    // The cast models a pure-JS caller / a test-time forced value; pre-T.7.A
    // there is no production code path that produces `'txf'` against the
    // public type. The shim is the runtime guard against this.
    let captured: unknown = null;
    try {
      narrowTransferMode('txf' as TransferMode);
      expect.fail('expected SphereError, got no throw');
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      const code: SphereErrorCode = captured.code;
      expect(code).toBe('UNSUPPORTED_TRANSFER_MODE');
      // Message mentions T.7.A so future maintainers find the planned
      // unblocking task without grepping the spec.
      expect(captured.message).toMatch(/T\.7\.A/);
    }
  });

  it('rejects an arbitrary unknown string with UNSUPPORTED_TRANSFER_MODE', () => {
    // Untyped JS callers and stale call-sites can smuggle in a value that
    // is neither in the public nor the internal union. Verify the shim
    // still throws the same typed code.
    let captured: unknown = null;
    try {
      narrowTransferMode('legacy-relay-only' as unknown as TransferMode);
      expect.fail('expected SphereError, got no throw');
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      expect(captured.code).toBe('UNSUPPORTED_TRANSFER_MODE');
    }
  });

  it('returns a value typed as InternalTransferMode (compile-time check)', () => {
    const out = narrowTransferMode('instant');
    expectTypeOf(out).toEqualTypeOf<InternalTransferMode>();
  });
});

// ---------------------------------------------------------------------------
// Runtime narrowing — `assertConservativeOrInstant`
// ---------------------------------------------------------------------------

describe('assertConservativeOrInstant', () => {
  it('passes through "instant" and "conservative"', () => {
    expect(assertConservativeOrInstant('instant')).toBe('instant');
    expect(assertConservativeOrInstant('conservative')).toBe('conservative');
  });

  it('throws UNSUPPORTED_TRANSFER_MODE for "txf"', () => {
    let captured: unknown = null;
    try {
      assertConservativeOrInstant('txf' as InternalTransferMode);
      expect.fail('expected SphereError, got no throw');
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      expect(captured.code).toBe('UNSUPPORTED_TRANSFER_MODE');
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime narrowing — `coercePartialTransferRequestMode`
// ---------------------------------------------------------------------------

describe('coercePartialTransferRequestMode', () => {
  it('reads `transferMode` off a partial request and narrows it', () => {
    expect(coercePartialTransferRequestMode({ transferMode: 'instant' })).toBe('instant');
    expect(coercePartialTransferRequestMode({ transferMode: 'conservative' })).toBe('conservative');
    expect(coercePartialTransferRequestMode({})).toBe('instant');
    expect(coercePartialTransferRequestMode({ transferMode: undefined })).toBe('instant');
  });

  it('rejects "txf" cast onto the request field', () => {
    let captured: unknown = null;
    try {
      coercePartialTransferRequestMode({ transferMode: 'txf' as TransferMode });
      expect.fail('expected SphereError, got no throw');
    } catch (err) {
      captured = err;
    }
    expect(isSphereError(captured)).toBe(true);
    if (isSphereError(captured)) {
      expect(captured.code).toBe('UNSUPPORTED_TRANSFER_MODE');
    }
  });
});

// ---------------------------------------------------------------------------
// Compile-time widening — `TransferRequest` accepts the seven new optional fields
// ---------------------------------------------------------------------------

describe('TransferRequest widening (compile-time)', () => {
  it('accepts the legacy single-coin shape unchanged', () => {
    const legacy = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000000',
    } satisfies TransferRequest;
    expect(legacy.recipient).toBe('@bob');
  });

  it('accepts every new optional field per §T.1.B.1 acceptance', () => {
    // Touch every new field at least once. The `satisfies` operator
    // gives us compile-time errors if a field name or type is wrong.
    const additionalAssets: ReadonlyArray<AdditionalAsset> = [
      { kind: 'coin', coinId: 'USDU', amount: '500000' },
      { kind: 'nft', tokenId: '0xabc123' },
    ];
    const delivery: DeliveryStrategy = { kind: 'auto', inlineCapBytes: 16384 };
    const widened = {
      recipient: '@bob',
      coinId: 'UCT',                  // optional but present
      amount: '1000000',              // optional but present
      additionalAssets,               // NEW
      allowPendingTokens: false,      // NEW
      confirmNftPending: false,       // NEW
      delivery,                       // NEW (re-exported from uxf-transfer)
      txfFinalization: 'conservative',// NEW
      transferMode: 'instant',
    } satisfies TransferRequest;
    expect(widened.additionalAssets?.length).toBe(2);
  });

  it('accepts an NFT-only send (no primary coin slot)', () => {
    const nftOnly = {
      recipient: '@bob',
      additionalAssets: [{ kind: 'nft', tokenId: '0xdeadbeef' }] as const,
    } satisfies TransferRequest;
    expect(nftOnly.recipient).toBe('@bob');
  });

  it('accepts a force-cid delivery strategy', () => {
    const forceCid = {
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1',
      delivery: { kind: 'force-cid' },
    } satisfies TransferRequest;
    expect(forceCid.delivery?.kind).toBe('force-cid');
  });

  it('disallows unknown additional-asset `kind` at the type level', () => {
    // `@ts-expect-error` is the test — if the union widens, this fails
    // and we know we have to update the spec.
    // @ts-expect-error - 'voucher' is not in AdditionalAsset
    const _bad: AdditionalAsset = { kind: 'voucher', tokenId: 'x' };
    // Touch the value so it is not a dead store.
    expect(_bad).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Compile-time widening — `AssetTarget` and the asset-kind type guards
// ---------------------------------------------------------------------------

describe('AssetTarget / type guards', () => {
  it('isCoinAsset narrows to the coin shape', () => {
    const a: AssetTarget = { kind: 'coin', coinId: 'UCT', amount: '1' };
    expect(isCoinAsset(a)).toBe(true);
    if (isCoinAsset(a)) {
      // Compile-time: `a.amount` must be visible after the narrow.
      expectTypeOf(a.amount).toEqualTypeOf<string>();
      expect(a.amount).toBe('1');
    }
    expect(isNftAsset(a)).toBe(false);
  });

  it('isNftAsset narrows to the nft shape', () => {
    const t: AssetTarget = { kind: 'nft', tokenId: '0xabc' };
    expect(isNftAsset(t)).toBe(true);
    if (isNftAsset(t)) {
      expectTypeOf(t.tokenId).toEqualTypeOf<string>();
      expect(t.tokenId).toBe('0xabc');
    }
    expect(isCoinAsset(t)).toBe(false);
  });
});
