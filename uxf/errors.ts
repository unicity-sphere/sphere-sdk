/**
 * UXF error codes covering all failure modes in the UXF module.
 */
export type UxfErrorCode =
  | 'INVALID_HASH'
  | 'MISSING_ELEMENT'
  | 'TOKEN_NOT_FOUND'
  | 'STATE_INDEX_OUT_OF_RANGE'
  | 'TYPE_MISMATCH'
  | 'INVALID_INSTANCE_CHAIN'
  | 'DUPLICATE_TOKEN'
  | 'SERIALIZATION_ERROR'
  | 'VERIFICATION_FAILED'
  | 'CYCLE_DETECTED'
  | 'INVALID_PACKAGE'
  | 'NOT_IMPLEMENTED';

/**
 * Structured error for all UXF operations.
 * Formats as `[UXF:<CODE>] <message>` for easy log filtering.
 */
export class UxfError extends Error {
  constructor(
    readonly code: UxfErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`[UXF:${code}] ${message}`);
    this.name = 'UxfError';
  }
}
