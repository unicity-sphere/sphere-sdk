/**
 * Shared header-field validation for UXF parsers.
 *
 * Steelman²¹: extracted from json.ts and ipld.ts to keep the validation
 * rule (representation/semantics must be safe non-negative integers) in
 * one place. A future protocol change (e.g., upper version cap, BigInt
 * acceptance) requires editing only this helper.
 *
 * @module uxf/header-validation
 */

import { UxfError } from './errors.js';
import type { UxfErrorCode } from './errors.js';
import type { UxfInstanceKind } from './types.js';

/**
 * Assert that a value is a "safe non-negative integer" — finite,
 * integer, ≥ 0, ≤ Number.MAX_SAFE_INTEGER. Used for header.representation
 * and header.semantics, which must be precision-comparable via `<`.
 *
 * Steelman²⁴: takes an `errorCode` parameter so callers can route the
 * UxfError through their domain. Parsers (json.ts/ipld.ts) use
 * 'SERIALIZATION_ERROR'; programmatic write paths (instance-chain.ts
 * addInstance) use 'INVALID_INSTANCE_CHAIN'. Defaults to
 * 'SERIALIZATION_ERROR' to preserve previous parse-boundary behavior.
 */
export function assertHeaderVersionField(
  value: unknown,
  fieldLabel: string,
  errorCode: UxfErrorCode = 'SERIALIZATION_ERROR',
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new UxfError(
      errorCode,
      `${fieldLabel} must be a non-negative safe integer, got ${String(value)}`,
    );
  }
}

/**
 * Maximum allowed length for header.kind strings, measured in UTF-16
 * code units (matching `String.prototype.length` semantics).
 *
 * Bounds memory cost at the parse boundary: an attacker-supplied 1MB+
 * kind would otherwise propagate through pool storage, hash computation
 * (slow), index structures, and persistent state. 64 UTF-16 units
 * accommodates all current well-known kinds plus reasonable future
 * extensions. Note on visible-character count: each non-BMP codepoint
 * (e.g., most emoji) encodes to 2 UTF-16 units (a surrogate pair), so
 * 32 emoji codepoints = 64 UTF-16 units, exhausting the cap. The cap
 * is therefore conservative for non-BMP-heavy strings (fewer visible
 * characters than the unit count for non-BMP codepoints).
 */
export const MAX_KIND_LENGTH = 64;

/**
 * Assert that a value is a non-empty string suitable for use as a
 * UxfInstanceKind. JSON.parse / CBOR-decode can produce null, numbers,
 * objects, etc.; the `as UxfInstanceKind` cast at parse boundaries lies
 * unless we runtime-check.
 *
 * Steelman²² note: enforces an upper length bound (MAX_KIND_LENGTH).
 * Steelman²⁴: takes an `errorCode` parameter — see assertHeaderVersionField.
 */
export function assertHeaderKindField(
  value: unknown,
  fieldLabel: string,
  errorCode: UxfErrorCode = 'SERIALIZATION_ERROR',
): asserts value is UxfInstanceKind {
  if (typeof value !== 'string' || value.length === 0) {
    throw new UxfError(
      errorCode,
      `${fieldLabel} must be a non-empty string, got ${String(value)}`,
    );
  }
  if (value.length > MAX_KIND_LENGTH) {
    throw new UxfError(
      errorCode,
      `${fieldLabel} length ${value.length} (UTF-16 code units) exceeds MAX_KIND_LENGTH=${MAX_KIND_LENGTH}`,
    );
  }
}
