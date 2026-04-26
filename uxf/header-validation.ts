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
import type { UxfInstanceKind } from './types.js';

/**
 * Assert that a value is a "safe non-negative integer" — finite,
 * integer, ≥ 0, ≤ Number.MAX_SAFE_INTEGER. Used for header.representation
 * and header.semantics, which must be precision-comparable via `<`.
 *
 * Throws UxfError(SERIALIZATION_ERROR) on failure with a message
 * referencing the field name and parser context.
 */
export function assertHeaderVersionField(
  value: unknown,
  fieldLabel: string,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  ) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `${fieldLabel} must be a non-negative safe integer, got ${String(value)}`,
    );
  }
}

/**
 * Assert that a value is a non-empty string suitable for use as a
 * UxfInstanceKind. JSON.parse / CBOR-decode can produce null, numbers,
 * objects, etc.; the `as UxfInstanceKind` cast at parse boundaries lies
 * unless we runtime-check.
 */
export function assertHeaderKindField(
  value: unknown,
  fieldLabel: string,
): asserts value is UxfInstanceKind {
  if (typeof value !== 'string' || value.length === 0) {
    throw new UxfError(
      'SERIALIZATION_ERROR',
      `${fieldLabel} must be a non-empty string, got ${String(value)}`,
    );
  }
}
