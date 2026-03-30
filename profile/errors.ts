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
  constructor(
    readonly code: ProfileErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`[PROFILE:${code}] ${message}`);
    this.name = 'ProfileError';
  }
}
