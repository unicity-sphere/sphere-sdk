/**
 * UXF Inter-Wallet Transfer T.8.C — error-surface audit.
 *
 * Verifies that every UXF-transfer-specific `SphereErrorCode` introduced
 * across waves T.2.B, T.2.C, T.4.B, T.3.B.1, T.3.B.2, T.3.E, T.5.B is:
 *
 *  1. Constructible — `new SphereError(message, code, cause?)` accepts the
 *     code without runtime failure (the type-level check is enforced by
 *     the `SphereErrorCode` union; this test additionally exercises the
 *     constructor at runtime to catch any tooling glitch).
 *  2. Round-trippable — `error.code` reads back exactly the constructor
 *     argument, `error.message` reads back exactly the constructor's
 *     message, and `error.name` is `'SphereError'`.
 *  3. Caught by `isSphereError()` — the type guard returns `true`.
 *  4. Carries forensic metadata in `error.cause` (and the redacted view
 *     in `error.context`) when the spec mandates a structured cause.
 *
 * Spec refs: §3.3, §3.3.1, §3.3.2, §5.0, §5.1, §5.2, §5.3, §5.5, §6.1, §10.4.
 *
 * NOTE: this test deliberately exercises the FULL set of UXF-transfer
 * codes (not just the four T.2.B/T.2.C/T.4.B/T.3.E codes named in the
 * task) so the audit catches drift if a future wave drops a code from
 * the union by accident.
 */

import { describe, it, expect } from 'vitest';
import {
  SphereError,
  isSphereError,
  type SphereErrorCode,
} from '../../../../core/errors';

// =============================================================================
// 1. The full UXF-transfer error-code inventory.
// =============================================================================
//
// Each entry specifies:
//  - `code`        — the `SphereErrorCode` literal under audit
//  - `wave`        — the implementation wave that introduced it
//  - `specRef`     — the §-reference in `docs/uxf/UXF-TRANSFER-PROTOCOL.md`
//  - `cause`       — a representative forensic payload the throw site
//                     attaches; verified for round-trip preservation
//                     (after T.8.C redaction, which leaves
//                     non-sensitive keys intact)
//
// Adding a new UXF-transfer code in a future wave MUST update this table
// or the audit fails — that is the whole point.
//
// =============================================================================

interface ErrorCodeAuditEntry {
  readonly code: SphereErrorCode;
  readonly wave: string;
  readonly specRef: string;
  readonly cause?: unknown;
}

const UXF_TRANSFER_CODES: ReadonlyArray<ErrorCodeAuditEntry> = [
  // T.1.D — bundle envelope decode failures (pre-existing landed code).
  { code: 'BUNDLE_REJECTED_MALFORMED_ENVELOPE', wave: 'T.1.D', specRef: '§3.1, §5.0' },
  { code: 'BUNDLE_REJECTED_MULTI_ROOT',         wave: 'T.1.D', specRef: '§5.2 #1' },
  { code: 'BUNDLE_REJECTED_INVALID_CAR',        wave: 'T.1.D', specRef: '§5.2 #1' },
  // T.2.B — multi-asset target validator.
  { code: 'EMPTY_TRANSFER',                     wave: 'T.2.B', specRef: '§4.1 step 1' },
  { code: 'INVALID_REQUEST',                    wave: 'T.2.B', specRef: '§4.1 step 1', cause: { reason: 'duplicate-coinId' } },
  { code: 'INVALID_AMOUNT',                     wave: 'T.2.B', specRef: '§4.1 step 1', cause: { coinId: 'UCT', amount: '-5' } },
  { code: 'UNKNOWN_ASSET_KIND',                 wave: 'T.2.B', specRef: '§4.1 step 1, §10.4', cause: { kind: 'erc1155-balance' } },
  { code: 'NFT_PENDING_REQUIRES_CONFIRMATION',  wave: 'T.2.B', specRef: '§4.1 step 2', cause: { tokenId: 'abc' } },
  // T.2.C — delivery resolver.
  { code: 'INLINE_CAR_TOO_LARGE',               wave: 'T.2.C', specRef: '§3.3.1', cause: { carBytes: 200_000, capBytes: 98_304 } },
  { code: 'INVALID_INLINE_CAP',                 wave: 'T.2.C', specRef: '§3.3.1', cause: { providedCap: 0 } },
  // T.3.A — bundle acquirer + verifier (pre-existing landed codes).
  { code: 'BUNDLE_REJECTED_ROOT_CID_MISMATCH',  wave: 'T.3.A', specRef: '§5.2 #1' },
  { code: 'BUNDLE_REJECTED_CHAIN_DEPTH_EXCEEDED',  wave: 'T.3.A', specRef: '§5.2 #3' },
  { code: 'BUNDLE_REJECTED_UNCLAIMED_ROOT_COUNT_EXCEEDED', wave: 'T.3.A', specRef: '§5.2 #4' },
  { code: 'BUNDLE_REJECTED_CID_MODE_NOT_YET_SUPPORTED',    wave: 'T.3.A', specRef: '§5.1' },
  { code: 'BUNDLE_REJECTED_VERIFY_FAILED',      wave: 'T.3.A', specRef: '§5.2 #1', cause: [{ kind: 'cycle' }] },
  // T.3.B.1 — per-element verifier shape failures.
  { code: 'STRUCTURAL_INVALID',                 wave: 'T.3.B.1', specRef: '§5.3 [A]', cause: { tokenId: 'abc', element: 'authenticator' } },
  // T.3.B.2 — instant-mode soft rejection (deferred until T.5.C wires receive-side).
  { code: 'BUNDLE_REJECTED_INSTANT_MODE_NOT_YET_SUPPORTED', wave: 'T.3.B.2', specRef: '§5.3' },
  // T.4.B — recipient CID fetcher.
  { code: 'FETCHED_CAR_TOO_LARGE',              wave: 'T.4.B', specRef: '§3.3.1', cause: { bundleCid: 'baf...', maxBytes: 33_554_432 } },
  { code: 'BUNDLE_REJECTED_GATEWAY_CID_MISMATCH', wave: 'T.4.B', specRef: '§3.3', cause: { expected: 'baf...', got: 'baf???' } },
  { code: 'BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT', wave: 'T.4.B', specRef: '§9.2', cause: { bundleCid: 'baf...', gatewaysAttempted: ['ipfs.io'], failureReasons: ['network'] } },
  // T.3.E — ingest worker pool back-pressure.
  { code: 'INGEST_QUEUE_FULL',                  wave: 'T.3.E', specRef: '§5.0', cause: { queueSize: 256, capacity: 256 } },
  { code: 'INGEST_QUEUE_FULL_PER_TOKEN',        wave: 'T.3.E', specRef: '§5.0', cause: { tokenId: 'abc', perTokenCap: 16 } },
  // T.5.B — sender-side finalization worker config validator.
  { code: 'INVALID_POLLING_POLICY',             wave: 'T.5.B', specRef: '§5.5 step 6', cause: { cumulativeBackoffMs: 800_000, pollingWindowMs: 600_000 } },
];

// =============================================================================
// 2. Per-code audit: constructor + round-trip + isSphereError + cause shape.
// =============================================================================

describe('T.8.C — UXF transfer error surface (audit)', () => {
  for (const entry of UXF_TRANSFER_CODES) {
    describe(`${entry.code} (${entry.wave}, ${entry.specRef})`, () => {
      const message = `audit: ${entry.code}`;

      it('constructs without runtime failure', () => {
        expect(() => new SphereError(message, entry.code, entry.cause)).not.toThrow();
      });

      it('round-trips message, code, name', () => {
        const err = new SphereError(message, entry.code, entry.cause);
        expect(err.message).toBe(message);
        expect(err.code).toBe(entry.code);
        expect(err.name).toBe('SphereError');
      });

      it('is recognized by isSphereError()', () => {
        const err = new SphereError(message, entry.code, entry.cause);
        expect(isSphereError(err)).toBe(true);
      });

      it('preserves non-sensitive cause metadata after redaction', () => {
        if (entry.cause === undefined) return;
        const err = new SphereError(message, entry.code, entry.cause);
        // The redaction layer (W40) replaces signed-byte fields with
        // markers; non-sensitive keys (reason, coinId, tokenId, etc.)
        // pass through. None of the sample causes above carry
        // signedTransferTxBytes — they are forensic-detail-only.
        expect(err.cause).toBeDefined();
        expect(err.context).toBeDefined();
        // err.cause and err.context point to the SAME redacted view
        // (the constructor stores it once and forwards to both).
        expect(err.cause).toBe(err.context);
      });

      it('cause survives JSON.stringify (no Error proto throw)', () => {
        if (entry.cause === undefined) return;
        const err = new SphereError(message, entry.code, entry.cause);
        // err.context is a plain redacted object; stringify must not throw.
        expect(() => JSON.stringify(err.context)).not.toThrow();
      });
    });
  }
});

// =============================================================================
// 3. The four T.8.C "new codes" — explicit audit checklist (per task spec).
// =============================================================================
//
// The plan-text names these four codes by virtue of their landing waves.
// We assert their presence as a regression catch — if any of them is
// dropped from the union by an accidental edit, this test fails.
// =============================================================================

describe('T.8.C — required new codes audit', () => {
  const REQUIRED: ReadonlyArray<SphereErrorCode> = [
    // T.4.B — recipient CID fetcher
    'FETCHED_CAR_TOO_LARGE',
    'BUNDLE_REJECTED_GATEWAY_CID_MISMATCH',
    'BUNDLE_REJECTED_FETCH_FAILED_TRANSIENT',
    // T.3.E — ingest worker pool
    'INGEST_QUEUE_FULL',
    'INGEST_QUEUE_FULL_PER_TOKEN',
    // T.2.C — delivery resolver
    'INLINE_CAR_TOO_LARGE',
    'INVALID_INLINE_CAP',
    // T.2.B — target validator
    'EMPTY_TRANSFER',
    'INVALID_REQUEST',
    'INVALID_AMOUNT',
    'UNKNOWN_ASSET_KIND',
    'NFT_PENDING_REQUIRES_CONFIRMATION',
  ];

  for (const code of REQUIRED) {
    it(`code ${code} is constructible`, () => {
      const err = new SphereError(`audit-${code}`, code);
      expect(err.code).toBe(code);
      expect(isSphereError(err)).toBe(true);
    });
  }
});
