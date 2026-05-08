/**
 * UXF Inter-Wallet Transfer T.8.C / W40 — SphereError redaction layer.
 *
 * Spec ref: `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` §13 / T.8.C — "errors
 * carrying signed transfer bytes (e.g., REQUEST_ID_MISMATCH client-error
 * path) MUST redact the bytes before logging or surfacing to UI consumers."
 *
 * Threat model:
 *  - A throw site (e.g., the §6.1 finalization-worker-sender REQUEST_ID_MISMATCH
 *    branch) attaches a forensic `cause` containing `signedTransferTxBytes`
 *    so operators can diagnose the client-error case.
 *  - That cause MUST NOT reach a logger, a UI surface, a telemetry packet,
 *    or `JSON.stringify(error.context)` in raw form. Replay of the bytes
 *    under our key would re-execute the transition.
 *
 * The redaction layer (`core/errors.ts`) walks `cause` ONCE at construction
 * time, deep-cloning it into a redacted view. Field names listed in
 * `REDACTED_FIELDS` are replaced with an opaque marker. The original bytes
 * are NOT retained on the error instance — the constructor's local
 * reference goes out of scope as soon as it returns.
 *
 * Tested invariants:
 *  1. `signedTransferTxBytes`, `signedCommitmentBytes`, `rawAuthenticator`
 *     are listed in the exported `REDACTED_FIELDS` constant.
 *  2. A SphereError whose cause has `signedTransferTxBytes: Uint8Array`
 *     redacts to `[REDACTED: signedTransferTxBytes(<n>-bytes)]` —
 *     - in `error.cause`,
 *     - in `error.context`,
 *     - in `JSON.stringify(error.context)`,
 *     - in `JSON.stringify({ cause: error.cause })`,
 *     - in `String(error)`-derived inspections (Node's `util.inspect`).
 *  3. Non-sensitive sibling fields (e.g., `requestId`, `tokenId`, `reason`)
 *     pass through unredacted.
 *  4. Nested cause structures (cause inside cause inside cause) all get
 *     redacted; the depth cap fires only for pathologically-deep input.
 *  5. Arrays of redaction targets are redacted element-by-element.
 *  6. Cycle-safe — a self-referential cause does NOT loop forever.
 *  7. The exported `redactCause()` helper has the same behavior as the
 *     constructor's automatic redaction.
 *  8. Other binary fields not listed in REDACTED_FIELDS pass through
 *     unchanged (the layer is allow-list driven, not deny-all-bytes).
 *  9. Top-level Uint8Array as the cause itself is passed through (the
 *     redaction is field-name-driven; a bare buffer doesn't carry a name).
 */

import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';

import {
  SphereError,
  REDACTED_FIELDS,
  redactCause,
  isSphereError,
} from '../../../../core/errors';

// =============================================================================
// 1. Constant inventory — the redaction set MUST include the three
// explicitly-named fields. Drift on this set defeats the defense.
// =============================================================================

describe('W40 — REDACTED_FIELDS inventory', () => {
  it('lists signedTransferTxBytes', () => {
    expect(REDACTED_FIELDS).toContain('signedTransferTxBytes');
  });

  it('lists signedCommitmentBytes', () => {
    expect(REDACTED_FIELDS).toContain('signedCommitmentBytes');
  });

  it('lists rawAuthenticator', () => {
    expect(REDACTED_FIELDS).toContain('rawAuthenticator');
  });

  it('is frozen so nothing can mutate the set at runtime', () => {
    expect(Object.isFrozen(REDACTED_FIELDS)).toBe(true);
  });
});

// =============================================================================
// 2. Top-level redaction — the field MUST disappear from cause / context.
// =============================================================================

describe('W40 — signedTransferTxBytes never surfaces in error.cause / context', () => {
  const SECRET_BYTES = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);

  it('replaces signedTransferTxBytes with a redaction marker in error.cause', () => {
    const err = new SphereError(
      'REQUEST_ID_MISMATCH on submit',
      'STRUCTURAL_INVALID',
      {
        requestId: 'req-abc',
        tokenId: 'tok-xyz',
        reason: 'client-error',
        signedTransferTxBytes: SECRET_BYTES,
      },
    );
    const cause = err.cause as { signedTransferTxBytes: unknown };
    expect(cause.signedTransferTxBytes).toBe(
      `[REDACTED: signedTransferTxBytes(${SECRET_BYTES.byteLength}-bytes)]`,
    );
    // Non-sensitive siblings preserved.
    expect((err.cause as { requestId: string }).requestId).toBe('req-abc');
    expect((err.cause as { tokenId: string }).tokenId).toBe('tok-xyz');
    expect((err.cause as { reason: string }).reason).toBe('client-error');
  });

  it('error.context exposes the SAME redacted view as error.cause', () => {
    const err = new SphereError('m', 'STRUCTURAL_INVALID', {
      signedTransferTxBytes: SECRET_BYTES,
    });
    expect(err.context).toBe(err.cause);
  });

  it('JSON.stringify(error.context) contains the marker, not the bytes', () => {
    const err = new SphereError('m', 'STRUCTURAL_INVALID', {
      signedTransferTxBytes: SECRET_BYTES,
    });
    const json = JSON.stringify(err.context);
    expect(json).toContain('[REDACTED: signedTransferTxBytes');
    // No raw bytes (any of: 'deadbeefcafe', escaped Þ etc, base64-of-secret).
    expect(json.toLowerCase()).not.toContain('deadbeef');
    // The base64 of the SECRET_BYTES would be '3q2+78r+'; ensure it's absent.
    const b64 = Buffer.from(SECRET_BYTES).toString('base64');
    expect(json).not.toContain(b64);
  });

  it('JSON.stringify({ cause: error.cause }) contains the marker, not the bytes', () => {
    const err = new SphereError('m', 'STRUCTURAL_INVALID', {
      signedTransferTxBytes: SECRET_BYTES,
    });
    const json = JSON.stringify({ cause: err.cause });
    expect(json).toContain('[REDACTED: signedTransferTxBytes');
    const b64 = Buffer.from(SECRET_BYTES).toString('base64');
    expect(json).not.toContain(b64);
  });

  it("util.inspect(err) does not leak the raw byte values", () => {
    const err = new SphereError('m', 'STRUCTURAL_INVALID', {
      signedTransferTxBytes: SECRET_BYTES,
    });
    const out = inspect(err, { depth: 6 });
    expect(out).toContain('[REDACTED: signedTransferTxBytes');
    // 'deadbeef' would only appear if the buffer leaked.
    expect(out.toLowerCase()).not.toContain('de ad be ef');
    expect(out.toLowerCase()).not.toContain('deadbeef');
  });
});

// =============================================================================
// 3. signedCommitmentBytes / rawAuthenticator — same treatment.
// =============================================================================

describe('W40 — signedCommitmentBytes redaction', () => {
  it('replaces signedCommitmentBytes with marker', () => {
    const buf = new Uint8Array([1, 2, 3, 4]);
    const err = new SphereError('m', 'STRUCTURAL_INVALID', {
      signedCommitmentBytes: buf,
    });
    expect(
      (err.context as { signedCommitmentBytes: string }).signedCommitmentBytes,
    ).toBe('[REDACTED: signedCommitmentBytes(4-bytes)]');
  });
});

describe('W40 — rawAuthenticator redaction', () => {
  it('replaces rawAuthenticator with marker', () => {
    const buf = new Uint8Array([0x01, 0x02]);
    const err = new SphereError('m', 'STRUCTURAL_INVALID', {
      rawAuthenticator: buf,
    });
    expect(
      (err.context as { rawAuthenticator: string }).rawAuthenticator,
    ).toBe('[REDACTED: rawAuthenticator(2-bytes)]');
  });

  it('still redacts when the value is a plain string (e.g., hex-encoded)', () => {
    const err = new SphereError('m', 'STRUCTURAL_INVALID', {
      rawAuthenticator: '0xabcdef0123456789',
    });
    const out = (err.context as { rawAuthenticator: string }).rawAuthenticator;
    expect(out.startsWith('[REDACTED: rawAuthenticator')).toBe(true);
    expect(out).not.toContain('abcdef0123456789');
  });
});

// =============================================================================
// 4. Nested causes — redaction MUST walk the whole tree.
// =============================================================================

describe('W40 — nested cause redaction', () => {
  it('redacts signedTransferTxBytes nested under another object', () => {
    const buf = new Uint8Array([0xaa, 0xbb]);
    const err = new SphereError('m', 'STRUCTURAL_INVALID', {
      requestId: 'req-1',
      details: {
        attempt: 3,
        outcome: {
          kind: 'REQUEST_ID_MISMATCH',
          signedTransferTxBytes: buf,
        },
      },
    });
    const ctx = err.context as {
      details: { outcome: { signedTransferTxBytes: string; kind: string } };
    };
    expect(ctx.details.outcome.signedTransferTxBytes).toBe(
      '[REDACTED: signedTransferTxBytes(2-bytes)]',
    );
    expect(ctx.details.outcome.kind).toBe('REQUEST_ID_MISMATCH');
  });

  it('redacts signedTransferTxBytes inside an array element', () => {
    const buf = new Uint8Array([0xff]);
    const err = new SphereError('m', 'STRUCTURAL_INVALID', {
      queueEntries: [
        { tokenId: 't1', signedTransferTxBytes: buf },
        { tokenId: 't2' },
      ],
    });
    const ctx = err.context as {
      queueEntries: Array<{ tokenId: string; signedTransferTxBytes?: string }>;
    };
    expect(ctx.queueEntries).toHaveLength(2);
    expect(ctx.queueEntries[0].signedTransferTxBytes).toBe(
      '[REDACTED: signedTransferTxBytes(1-bytes)]',
    );
    expect(ctx.queueEntries[0].tokenId).toBe('t1');
    expect(ctx.queueEntries[1].signedTransferTxBytes).toBeUndefined();
    expect(ctx.queueEntries[1].tokenId).toBe('t2');
  });

  it('preserves array-ness on the top-level cause shape', () => {
    const err = new SphereError('m', 'BUNDLE_REJECTED_VERIFY_FAILED', [
      { kind: 'cycle' },
      { kind: 'orphan' },
    ]);
    expect(Array.isArray(err.cause)).toBe(true);
    expect((err.cause as Array<{ kind: string }>)[0].kind).toBe('cycle');
  });
});

// =============================================================================
// 5. Cycle safety — a self-referential cause must not loop forever.
// =============================================================================

describe('W40 — cycle-safe redaction', () => {
  it('does not infinite-loop on a self-referential cause', () => {
    interface Recur {
      requestId: string;
      self?: Recur;
      signedTransferTxBytes: Uint8Array;
    }
    const cause: Recur = {
      requestId: 'req-1',
      signedTransferTxBytes: new Uint8Array([0x42]),
    };
    cause.self = cause; // cycle
    const err = new SphereError('m', 'STRUCTURAL_INVALID', cause);
    const ctx = err.context as Record<string, unknown>;
    expect(ctx.requestId).toBe('req-1');
    expect(ctx.signedTransferTxBytes).toBe(
      '[REDACTED: signedTransferTxBytes(1-bytes)]',
    );
    // The self-reference is preserved as the SAME cloned object — i.e.,
    // ctx.self === ctx (per the WeakMap memo policy). This is the only
    // shape that is both cycle-safe AND structure-preserving.
    expect(ctx.self).toBe(ctx);
  });
});

// =============================================================================
// 6. Field-name allow-list semantics — non-listed binary fields pass through.
// =============================================================================

describe('W40 — non-listed binary fields pass through', () => {
  it('does not redact a Uint8Array under an unlisted key', () => {
    const buf = new Uint8Array([1, 2, 3]);
    const err = new SphereError('m', 'STRUCTURAL_INVALID', {
      arbitraryBytes: buf, // not in REDACTED_FIELDS
    });
    const ctx = err.context as { arbitraryBytes: unknown };
    // Top-level Uint8Array is preserved by the redactor (it's identity-passthrough
    // for buffers; only field-name matches trigger replacement).
    expect(ctx.arbitraryBytes).toBeInstanceOf(Uint8Array);
  });

  it('does not redact a top-level bare Uint8Array as the entire cause', () => {
    const buf = new Uint8Array([0x01]);
    const err = new SphereError('m', 'STRUCTURAL_INVALID', buf);
    expect(err.cause).toBeInstanceOf(Uint8Array);
  });

  it('does not redact a top-level bare string', () => {
    const err = new SphereError('m', 'STRUCTURAL_INVALID', 'plain-string');
    expect(err.cause).toBe('plain-string');
  });
});

// =============================================================================
// 7. redactCause() helper — same behavior as constructor.
// =============================================================================

describe('W40 — redactCause() exported helper', () => {
  it('returns undefined when input is undefined', () => {
    expect(redactCause(undefined)).toBeUndefined();
  });

  it('returns the same redacted shape as the constructor', () => {
    const buf = new Uint8Array([7, 7, 7]);
    const cause = { tokenId: 't1', signedTransferTxBytes: buf };
    const direct = redactCause(cause) as Record<string, unknown>;
    const viaCtor = (new SphereError('m', 'STRUCTURAL_INVALID', cause)
      .context) as Record<string, unknown>;
    expect(direct.tokenId).toBe('t1');
    expect(direct.signedTransferTxBytes).toBe(
      '[REDACTED: signedTransferTxBytes(3-bytes)]',
    );
    expect(viaCtor.tokenId).toBe(direct.tokenId);
    expect(viaCtor.signedTransferTxBytes).toBe(direct.signedTransferTxBytes);
  });
});

// =============================================================================
// 8. error.message MUST NOT carry signed bytes (call-site discipline test).
// =============================================================================
//
// W40 also requires that `error.message` does not surface signed bytes.
// The message is provided by the caller — the redaction layer cannot
// rewrite it. But we can assert that no current throw site embeds raw
// bytes into the message string by enforcing that the recommended call-
// site idiom (message = pure string, bytes go into cause) survives the
// constructor as expected — this is a regression catch on the API
// contract.
// =============================================================================

describe('W40 — error.message stays as the constructor argument', () => {
  it('error.message is the literal constructor-arg string with no bytes appended', () => {
    const buf = new Uint8Array([0x99]);
    const err = new SphereError(
      'submit failed: requestId req-abc client-error',
      'STRUCTURAL_INVALID',
      { signedTransferTxBytes: buf },
    );
    expect(err.message).toBe('submit failed: requestId req-abc client-error');
    expect(err.message).not.toContain('99');
    expect(err.message).not.toContain('REDACTED');
  });
});

// =============================================================================
// 9. isSphereError still recognises a redacted-cause-bearing instance.
// =============================================================================

describe('W40 — isSphereError type guard works after redaction', () => {
  it('returns true for a redacted-cause-bearing SphereError', () => {
    const err = new SphereError('m', 'STRUCTURAL_INVALID', {
      signedTransferTxBytes: new Uint8Array([1]),
    });
    expect(isSphereError(err)).toBe(true);
  });
});

// =============================================================================
// 10. Steelman crit #17 — Error-instance bypass closure.
//
// Previously `redactValue` returned `Error` instances identity-untouched.
// That meant a hostile/forensic Error supplied as `cause` (or nested under
// `cause`) could carry an enumerable own-property like `signedTransferTxBytes`
// straight through the redaction layer.
//
// Fix: clone the Error preserving prototype, but redact own enumerable
// string-keyed properties.
// =============================================================================

describe('W40 — steelman crit #17: Error-instance bypass closed', () => {
  const SECRET_BYTES = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);

  it('redacts signedTransferTxBytes attached as own-property on a top-level Error cause', () => {
    const errCause = new Error('forensic');
    (errCause as unknown as { signedTransferTxBytes: Uint8Array }).signedTransferTxBytes =
      SECRET_BYTES;
    const err = new SphereError('m', 'STRUCTURAL_INVALID', errCause);
    const redactedCause = err.cause as { signedTransferTxBytes: unknown; message: string };
    expect(redactedCause.signedTransferTxBytes).toBe(
      `[REDACTED: signedTransferTxBytes(${SECRET_BYTES.byteLength}-bytes)]`,
    );
    // Message is preserved on the clone.
    expect(redactedCause.message).toBe('forensic');
  });

  it('redacts signedTransferTxBytes nested under a plain { cause: errorInstance }', () => {
    const errInner = new Error('inner');
    (errInner as unknown as { signedTransferTxBytes: Uint8Array }).signedTransferTxBytes =
      SECRET_BYTES;
    const err = new SphereError('m', 'STRUCTURAL_INVALID', { cause: errInner });
    const ctx = err.cause as { cause: { signedTransferTxBytes: unknown; message: string } };
    expect(ctx.cause.signedTransferTxBytes).toBe(
      `[REDACTED: signedTransferTxBytes(${SECRET_BYTES.byteLength}-bytes)]`,
    );
    expect(ctx.cause.message).toBe('inner');
  });

  it('preserves prototype identity — clone is still instanceof CustomError', () => {
    class CustomError extends Error {
      readonly tag: string;
      constructor(message: string, tag: string) {
        super(message);
        this.name = 'CustomError';
        this.tag = tag;
      }
    }
    const original = new CustomError('boom', 't1');
    (original as unknown as { signedTransferTxBytes: Uint8Array }).signedTransferTxBytes =
      SECRET_BYTES;
    const err = new SphereError('m', 'STRUCTURAL_INVALID', original);
    const clone = err.cause as unknown;
    expect(clone).toBeInstanceOf(CustomError);
    expect(clone).toBeInstanceOf(Error);
    expect((clone as CustomError).tag).toBe('t1');
    expect((clone as { signedTransferTxBytes: unknown }).signedTransferTxBytes).toBe(
      `[REDACTED: signedTransferTxBytes(${SECRET_BYTES.byteLength}-bytes)]`,
    );
  });

  it('drops symbol-keyed sensitive properties (load-bearing: Object.keys does not list symbols)', () => {
    const SECRET = Symbol('signedTransferTxBytes');
    const errCause = new Error('forensic');
    (errCause as unknown as Record<symbol, Uint8Array>)[SECRET] = SECRET_BYTES;
    const err = new SphereError('m', 'STRUCTURAL_INVALID', errCause);
    const clone = err.cause as Record<string, unknown>;
    // Symbol-keyed property is NOT carried over to the clone.
    expect((clone as Record<symbol, unknown>)[SECRET]).toBeUndefined();
  });

  it('drops non-enumerable sensitive properties (load-bearing: Object.keys lists only enumerables)', () => {
    const errCause = new Error('forensic');
    Object.defineProperty(errCause, 'signedTransferTxBytes', {
      value: SECRET_BYTES,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    const err = new SphereError('m', 'STRUCTURAL_INVALID', errCause);
    const clone = err.cause as Record<string, unknown>;
    // Non-enumerable property does not appear on the clone.
    expect(clone.signedTransferTxBytes).toBeUndefined();
  });

  it('handles a self-referential Error without infinite loop (WeakMap memo)', () => {
    const errCause = new Error('forensic');
    (errCause as unknown as { self?: unknown }).self = errCause;
    (errCause as unknown as { signedTransferTxBytes: Uint8Array }).signedTransferTxBytes =
      SECRET_BYTES;
    const err = new SphereError('m', 'STRUCTURAL_INVALID', errCause);
    const clone = err.cause as { self: unknown; signedTransferTxBytes: unknown };
    // The self-reference points at the SAME cloned object.
    expect(clone.self).toBe(clone);
    // Sensitive byte field still redacted on the single shared clone.
    expect(clone.signedTransferTxBytes).toBe(
      `[REDACTED: signedTransferTxBytes(${SECRET_BYTES.byteLength}-bytes)]`,
    );
  });
});
