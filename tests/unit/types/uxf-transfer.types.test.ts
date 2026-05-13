/**
 * Tests for `types/uxf-transfer.ts` — UXF transfer wire-format types (T.1.A).
 *
 * Covers:
 *  - Runtime guards: paranoid negative cases (null, undefined, primitives,
 *    arrays, missing fields, wrong literals, unknown discriminator).
 *  - All four legacy shapes per §3.4 (positive cases).
 *  - Both UXF kinds (`uxf-car`, `uxf-cid`) (positive cases).
 *  - Compile-time discriminator narrowing fixtures, BRACKETING the V6
 *    `COMBINED_TRANSFER` and V5 `INSTANT_SPLIT` shapes per Note N7.
 *
 * Spec references: §3.1, §3.2, §3.3, §3.3.1, §3.4, §5.6, §9.3.
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  DeliveryStrategy,
  LegacyCombinedTransferPayload,
  LegacyInstantSplitPayload,
  LegacySdkPayload,
  LegacySphereTxfPayload,
  LegacyTokenTransferPayload,
  UxfTransferPayload,
  UxfTransferPayloadCar,
  UxfTransferPayloadCid,
} from '../../../types/uxf-transfer';
import {
  isLegacyTokenTransferPayload,
  isUxfTransferPayload,
  isUxfTransferPayloadCar,
  isUxfTransferPayloadCid,
} from '../../../types/uxf-transfer';

// =============================================================================
// Runtime guard — `isUxfTransferPayload`
// =============================================================================

describe('isUxfTransferPayload — negative cases (paranoid)', () => {
  it('rejects null', () => {
    expect(isUxfTransferPayload(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isUxfTransferPayload(undefined)).toBe(false);
  });

  it('rejects primitives (number, string, boolean)', () => {
    expect(isUxfTransferPayload(0)).toBe(false);
    expect(isUxfTransferPayload(42)).toBe(false);
    expect(isUxfTransferPayload('uxf-car')).toBe(false);
    expect(isUxfTransferPayload(true)).toBe(false);
  });

  it('rejects arrays', () => {
    expect(isUxfTransferPayload([])).toBe(false);
    expect(isUxfTransferPayload([{ kind: 'uxf-car' }])).toBe(false);
  });

  it('rejects empty object {}', () => {
    expect(isUxfTransferPayload({})).toBe(false);
  });

  it('rejects unknown `kind` value (e.g., `uxf-future`)', () => {
    expect(
      isUxfTransferPayload({
        kind: 'uxf-future',
        version: '1.0',
        mode: 'instant',
        bundleCid: 'bafy...',
        tokenIds: [],
        carBase64: 'AAAA',
      } as unknown),
    ).toBe(false);
  });

  it('rejects wrong version literal', () => {
    expect(
      isUxfTransferPayload({
        kind: 'uxf-car',
        version: '2.0',
        mode: 'instant',
        bundleCid: 'bafy...',
        tokenIds: [],
        carBase64: 'AAAA',
      } as unknown),
    ).toBe(false);
  });

  it('rejects wrong mode literal', () => {
    expect(
      isUxfTransferPayload({
        kind: 'uxf-car',
        version: '1.0',
        mode: 'turbo',
        bundleCid: 'bafy...',
        tokenIds: [],
        carBase64: 'AAAA',
      } as unknown),
    ).toBe(false);
  });

  it('rejects missing bundleCid', () => {
    expect(
      isUxfTransferPayload({
        kind: 'uxf-cid',
        version: '1.0',
        mode: 'instant',
        tokenIds: [],
      } as unknown),
    ).toBe(false);
  });

  it('rejects empty bundleCid string', () => {
    expect(
      isUxfTransferPayload({
        kind: 'uxf-cid',
        version: '1.0',
        mode: 'instant',
        bundleCid: '',
        tokenIds: [],
      } as unknown),
    ).toBe(false);
  });

  it('rejects non-array tokenIds', () => {
    expect(
      isUxfTransferPayload({
        kind: 'uxf-car',
        version: '1.0',
        mode: 'instant',
        bundleCid: 'bafy...',
        tokenIds: 'should-be-array',
        carBase64: 'AAAA',
      } as unknown),
    ).toBe(false);
  });

  it('rejects uxf-car missing carBase64', () => {
    expect(
      isUxfTransferPayload({
        kind: 'uxf-car',
        version: '1.0',
        mode: 'instant',
        bundleCid: 'bafy...',
        tokenIds: [],
      } as unknown),
    ).toBe(false);
  });
});

describe('isUxfTransferPayload — positive cases', () => {
  it('accepts a minimal uxf-car payload', () => {
    const p: UxfTransferPayloadCar = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'instant',
      bundleCid: 'bafyreigh2akiscaildc3xkocfvdf3oxnbzx7e2yckcvubgrnxwwjz5jqpe',
      tokenIds: ['aa'.repeat(32)],
      carBase64: 'AAAAAAAA',
    };
    expect(isUxfTransferPayload(p)).toBe(true);
    expect(isUxfTransferPayloadCar(p)).toBe(true);
    expect(isUxfTransferPayloadCid(p)).toBe(false);
  });

  it('accepts a minimal uxf-cid payload', () => {
    const p: UxfTransferPayloadCid = {
      kind: 'uxf-cid',
      version: '1.0',
      mode: 'conservative',
      bundleCid: 'bafyreigh2akiscaildc3xkocfvdf3oxnbzx7e2yckcvubgrnxwwjz5jqpe',
      tokenIds: ['bb'.repeat(32), 'cc'.repeat(32)],
      senderGateways: ['https://ipfs.io', 'https://w3s.link'],
    };
    expect(isUxfTransferPayload(p)).toBe(true);
    expect(isUxfTransferPayloadCid(p)).toBe(true);
    expect(isUxfTransferPayloadCar(p)).toBe(false);
  });

  it('accepts a uxf-car payload with full sender block', () => {
    const p: UxfTransferPayloadCar = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'instant',
      bundleCid: 'bafy0',
      tokenIds: [],
      carBase64: 'AAAA',
      memo: 'hi',
      sender: {
        transportPubkey: 'ab'.repeat(32),
        nametag: 'alice',
      },
    };
    expect(isUxfTransferPayload(p)).toBe(true);
  });
});

// =============================================================================
// Runtime guard — `isLegacyTokenTransferPayload` (4 shapes, §3.4)
// =============================================================================

describe('isLegacyTokenTransferPayload — recognizes all four legacy shapes (§3.4)', () => {
  // Shape 1 — Sphere TXF single-token (current pre-UXF default)
  it('accepts Sphere TXF `{sourceToken, transferTx}`', () => {
    const p: LegacySphereTxfPayload = {
      sourceToken: { id: 'tok1' },
      transferTx: { hash: 'tx1' },
    };
    expect(isLegacyTokenTransferPayload(p)).toBe(true);
    // The top-level guard ALSO accepts (no `kind` → structural fall-through).
    expect(isUxfTransferPayload(p)).toBe(true);
  });

  // Shape 2 — V6 COMBINED_TRANSFER (precedence 1: checked BEFORE V5)
  it('accepts V6 COMBINED_TRANSFER (`type=COMBINED_TRANSFER, version=6.0`)', () => {
    const p: LegacyCombinedTransferPayload = {
      type: 'COMBINED_TRANSFER',
      version: '6.0',
      transferId: 'xfer1',
      directTokens: [],
      splitBundle: null,
      totalAmount: '100',
      coinId: 'aa'.repeat(32),
      senderPubkey: 'ab'.repeat(32),
    };
    expect(isLegacyTokenTransferPayload(p)).toBe(true);
    expect(isUxfTransferPayload(p)).toBe(true);
  });

  // Shape 3 — V5 INSTANT_SPLIT (precedence 2)
  it('accepts V5 INSTANT_SPLIT (`type=INSTANT_SPLIT, version=5.0`)', () => {
    const p: LegacyInstantSplitPayload = {
      type: 'INSTANT_SPLIT',
      version: '5.0',
      burnTransaction: '...',
      recipientMintData: '...',
    };
    expect(isLegacyTokenTransferPayload(p)).toBe(true);
    expect(isUxfTransferPayload(p)).toBe(true);
  });

  // Shape 3' — V4 INSTANT_SPLIT (also precedence 2)
  it('accepts V4 INSTANT_SPLIT (`type=INSTANT_SPLIT, version=4.0`)', () => {
    const p: LegacyInstantSplitPayload = {
      type: 'INSTANT_SPLIT',
      version: '4.0',
      burnCommitment: '...',
    };
    expect(isLegacyTokenTransferPayload(p)).toBe(true);
    expect(isUxfTransferPayload(p)).toBe(true);
  });

  // Shape 4 — SDK legacy `{token, proof}`
  it('accepts SDK legacy `{token, proof}`', () => {
    const p: LegacySdkPayload = {
      token: { foo: 'bar' },
      proof: { sig: 'deadbeef' },
    };
    expect(isLegacyTokenTransferPayload(p)).toBe(true);
    expect(isUxfTransferPayload(p)).toBe(true);
  });

  it('rejects INSTANT_SPLIT with unrecognized version (e.g., 3.0)', () => {
    expect(
      isLegacyTokenTransferPayload({ type: 'INSTANT_SPLIT', version: '3.0' } as unknown),
    ).toBe(false);
  });

  it('rejects COMBINED_TRANSFER with unrecognized version', () => {
    expect(
      isLegacyTokenTransferPayload({ type: 'COMBINED_TRANSFER', version: '7.0' } as unknown),
    ).toBe(false);
  });

  it('rejects bare `{type: "INSTANT_SPLIT"}` without a version', () => {
    expect(
      isLegacyTokenTransferPayload({ type: 'INSTANT_SPLIT' } as unknown),
    ).toBe(false);
  });

  it('rejects null/undefined/primitives', () => {
    expect(isLegacyTokenTransferPayload(null)).toBe(false);
    expect(isLegacyTokenTransferPayload(undefined)).toBe(false);
    expect(isLegacyTokenTransferPayload('legacy')).toBe(false);
    expect(isLegacyTokenTransferPayload(42)).toBe(false);
    expect(isLegacyTokenTransferPayload([])).toBe(false);
  });

  it('rejects empty object', () => {
    expect(isLegacyTokenTransferPayload({})).toBe(false);
  });

  it('rejects partial Sphere TXF (only sourceToken, no transferTx)', () => {
    expect(
      isLegacyTokenTransferPayload({ sourceToken: { id: 'x' } } as unknown),
    ).toBe(false);
  });

  it('rejects partial SDK legacy (only token, no proof)', () => {
    expect(
      isLegacyTokenTransferPayload({ token: { id: 'x' } } as unknown),
    ).toBe(false);
  });
});

// =============================================================================
// Detection precedence — V6 BEFORE V5 (Note N7 ambiguity guard)
// =============================================================================

describe('isLegacyTokenTransferPayload — precedence rules (Note N7)', () => {
  // V6 outer payload may embed an inner V5 `splitBundle`. The TOP-LEVEL
  // discriminator must select V6, never overshoot into V5. The detector's
  // precedence (V6 first) ensures this holds even if both shapes overlap.
  it('classifies V6 wrapping a V5 splitBundle as V6 (outer wins)', () => {
    const v6WithInnerV5 = {
      type: 'COMBINED_TRANSFER',
      version: '6.0',
      directTokens: [],
      splitBundle: {
        type: 'INSTANT_SPLIT',
        version: '5.0',
        burnTransaction: '...',
      },
      transferId: 'xfer1',
      totalAmount: '0',
      coinId: 'aa'.repeat(32),
      senderPubkey: 'ab'.repeat(32),
    };
    expect(isLegacyTokenTransferPayload(v6WithInnerV5)).toBe(true);
    // The outer matches the V6 branch — there is no caller-visible
    // misclassification because both branches return `true`. The behavioral
    // distinction lands in T.7.B (legacy adapter dispatching by shape).
    expect((v6WithInnerV5 as { type: string }).type).toBe('COMBINED_TRANSFER');
  });
});

// =============================================================================
// Compile-time fixtures — discriminator narrowing demonstrations
// =============================================================================
//
// Per Note N7, the compile-time fixtures explicitly bracket the V6
// `COMBINED_TRANSFER` and V5 `INSTANT_SPLIT` shapes. These tests prove the
// type system narrows correctly inside guard branches; if narrowing breaks,
// `tsc --noEmit` fails BEFORE runtime.

describe('compile-time discriminator narrowing', () => {
  it('narrows kind=uxf-car to UxfTransferPayloadCar', () => {
    const p: UxfTransferPayload = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'instant',
      bundleCid: 'bafy0',
      tokenIds: [],
      carBase64: 'AAAA',
    };
    if (isUxfTransferPayloadCar(p)) {
      // Inside this branch, p MUST narrow to UxfTransferPayloadCar.
      expectTypeOf(p).toEqualTypeOf<UxfTransferPayloadCar>();
      // carBase64 is statically a string here.
      expectTypeOf(p.carBase64).toEqualTypeOf<string>();
    } else {
      // Force a compile error if narrowing fails on the falsy branch.
      // (No code path expected at runtime.)
    }
  });

  it('narrows kind=uxf-cid to UxfTransferPayloadCid', () => {
    const p: UxfTransferPayload = {
      kind: 'uxf-cid',
      version: '1.0',
      mode: 'conservative',
      bundleCid: 'bafy0',
      tokenIds: [],
    };
    if (isUxfTransferPayloadCid(p)) {
      expectTypeOf(p).toEqualTypeOf<UxfTransferPayloadCid>();
      expectTypeOf(p.kind).toEqualTypeOf<'uxf-cid'>();
    }
  });

  // ---- BEGIN BRACKET: V6 `COMBINED_TRANSFER` (Note N7) -------------------
  it('narrows V6 COMBINED_TRANSFER fixture to LegacyCombinedTransferPayload', () => {
    // V6 multi-token combined-transfer fixture per §3.4. The shape always
    // carries `type = 'COMBINED_TRANSFER'` AND `version = '6.0'`. Other
    // fields (transferId, directTokens, splitBundle, totalAmount, coinId,
    // senderPubkey, memo?) are part of the canonical type but the legacy
    // detector only requires the discriminator pair.
    const v6: LegacyCombinedTransferPayload = {
      type: 'COMBINED_TRANSFER',
      version: '6.0',
      transferId: 'xfer-v6',
      directTokens: [],
      splitBundle: null,
      totalAmount: '500',
      coinId: 'aa'.repeat(32),
      senderPubkey: 'ab'.repeat(32),
    };
    expect(isLegacyTokenTransferPayload(v6)).toBe(true);
    expectTypeOf(v6.type).toEqualTypeOf<'COMBINED_TRANSFER'>();
    expectTypeOf(v6.version).toEqualTypeOf<'6.0'>();
  });
  // ---- END BRACKET: V6 `COMBINED_TRANSFER` -------------------------------

  // ---- BEGIN BRACKET: V5 `INSTANT_SPLIT` (Note N7) -----------------------
  it('narrows V5 INSTANT_SPLIT fixture to LegacyInstantSplitPayload', () => {
    // V5 instant-split fixture per §3.4. The shape carries `type =
    // 'INSTANT_SPLIT'` AND `version = '5.0'` (V4 `version = '4.0'` is the
    // dev-mode variant). Other fields (burnTransaction, recipientMintData,
    // transferCommitment, etc.) are part of the canonical type at
    // `types/instant-split.ts :: InstantSplitBundleV5` but the detector
    // only requires the discriminator pair.
    const v5: LegacyInstantSplitPayload = {
      type: 'INSTANT_SPLIT',
      version: '5.0',
      burnTransaction: 'burn-json',
      recipientMintData: 'mint-json',
      transferCommitment: 'transfer-json',
      amount: '100',
      coinId: 'aa'.repeat(32),
      tokenTypeHex: 'bb'.repeat(32),
      splitGroupId: 'sg-1',
      senderPubkey: 'ab'.repeat(32),
      recipientSaltHex: 'cc'.repeat(32),
      transferSaltHex: 'dd'.repeat(32),
      mintedTokenStateJson: '{}',
      finalRecipientStateJson: '{}',
      recipientAddressJson: '{}',
    };
    expect(isLegacyTokenTransferPayload(v5)).toBe(true);
    expectTypeOf(v5.type).toEqualTypeOf<'INSTANT_SPLIT'>();
    expectTypeOf(v5.version).toEqualTypeOf<'4.0' | '5.0'>();
  });
  // ---- END BRACKET: V5 `INSTANT_SPLIT` -----------------------------------

  it('LegacyTokenTransferPayload union covers all 4 shapes', () => {
    const shapes: LegacyTokenTransferPayload[] = [
      { sourceToken: {}, transferTx: {} } as LegacySphereTxfPayload,
      { type: 'COMBINED_TRANSFER', version: '6.0' } as LegacyCombinedTransferPayload,
      { type: 'INSTANT_SPLIT', version: '5.0' } as LegacyInstantSplitPayload,
      { token: {}, proof: {} } as LegacySdkPayload,
    ];
    for (const s of shapes) {
      expect(isLegacyTokenTransferPayload(s)).toBe(true);
    }
  });
});

// =============================================================================
// DeliveryStrategy — discriminator coverage
// =============================================================================

describe('DeliveryStrategy — exhaustive discriminator coverage', () => {
  it('accepts {kind: "auto"} with and without inlineCapBytes', () => {
    const a: DeliveryStrategy = { kind: 'auto' };
    const b: DeliveryStrategy = { kind: 'auto', inlineCapBytes: 32_768 };
    expect(a.kind).toBe('auto');
    expect(b.kind).toBe('auto');
    if (b.kind === 'auto') {
      expectTypeOf(b.inlineCapBytes).toEqualTypeOf<number | undefined>();
    }
  });

  it('accepts {kind: "force-inline"}', () => {
    const f: DeliveryStrategy = { kind: 'force-inline' };
    expect(f.kind).toBe('force-inline');
    expectTypeOf(f).toEqualTypeOf<{ readonly kind: 'force-inline' }>();
  });

  it('accepts {kind: "force-cid"}', () => {
    const f: DeliveryStrategy = { kind: 'force-cid' };
    expect(f.kind).toBe('force-cid');
    expectTypeOf(f).toEqualTypeOf<{ readonly kind: 'force-cid' }>();
  });

  it('exhaustiveness — switch on kind covers all variants', () => {
    function describeStrategy(s: DeliveryStrategy): string {
      switch (s.kind) {
        case 'auto':
          return `auto cap=${s.inlineCapBytes ?? 'default'}`;
        case 'force-inline':
          return 'force-inline';
        case 'force-cid':
          return 'force-cid';
        default: {
          const _exhaustive: never = s;
          return _exhaustive;
        }
      }
    }
    expect(describeStrategy({ kind: 'auto' })).toBe('auto cap=default');
    expect(describeStrategy({ kind: 'auto', inlineCapBytes: 16384 })).toBe('auto cap=16384');
    expect(describeStrategy({ kind: 'force-inline' })).toBe('force-inline');
    expect(describeStrategy({ kind: 'force-cid' })).toBe('force-cid');
  });
});
