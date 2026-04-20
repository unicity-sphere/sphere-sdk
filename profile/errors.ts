/**
 * UXF Profile Error Definitions
 *
 * Structured error codes and error class for all Profile operations.
 * Follows the same pattern as UxfError from uxf/errors.ts.
 */

/**
 * Error codes covering all failure modes in the Profile system.
 */
export type ProfileErrorCode =
  | 'PROFILE_NOT_INITIALIZED'
  | 'ORBITDB_WRITE_FAILED'
  | 'ORBITDB_READ_FAILED'
  | 'ORBITDB_CONNECTION_FAILED'
  | 'ORBITDB_NOT_INSTALLED'
  | 'BUNDLE_NOT_FOUND'
  | 'CONSOLIDATION_IN_PROGRESS'
  | 'MIGRATION_FAILED'
  | 'ENCRYPTION_FAILED'
  | 'DECRYPTION_FAILED'
  | 'BOOTSTRAP_REQUIRED';

/**
 * Structured error for all Profile operations.
 * Formats as `[PROFILE:<CODE>] <message>` for easy log filtering.
 */
export class ProfileError extends Error {
  readonly code: ProfileErrorCode;
  // Note: `cause` is inherited from `Error` when the options bag is used in
  // super(); we don't redeclare it as a class field (that would shadow the
  // native getter).
  constructor(code: ProfileErrorCode, message: string, cause?: unknown) {
    // Pass `cause` via the ES2022 options bag so `err.cause` is populated on
    // the native Error. Without this, tools that walk error chains via
    // `err.cause` (Node's default formatter, Sentry, pino-pretty) see nothing
    // and the inner stack is effectively orphaned.
    super(`[PROFILE:${code}] ${message}`, cause !== undefined ? { cause } : undefined);
    this.name = 'ProfileError';
    this.code = code;
  }
}
