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
  | 'PROFILE_KV_INIT_FAILED'
  | 'PROFILE_KV_NOT_OPEN'
  | 'PROFILE_KV_WRITE_FAILED'
  | 'PROFILE_KV_READ_FAILED'
  | 'PROFILE_KV_CONNECTION_FAILED'
  | 'BUNDLE_NOT_FOUND'
  | 'CONSOLIDATION_IN_PROGRESS'
  | 'MIGRATION_FAILED'
  | 'ENCRYPTION_FAILED'
  | 'DECRYPTION_FAILED'
  | 'BOOTSTRAP_REQUIRED'
  /** CidRef envelope is malformed / corrupt — distinct from BUNDLE_NOT_FOUND
   *  which signals IPFS unavailability. Callers MUST NOT retry on this
   *  code (the ref itself is bad; a retry will get the same result).
   *  See PROFILE-CID-REFERENCES.md §2.1. */
  | 'CID_REF_CORRUPT'
  /** CidRef was read but the injected CidRefStore is absent / misconfigured
   *  so the referenced IPFS content cannot be fetched. Distinct from
   *  BUNDLE_NOT_FOUND (content may still exist on IPFS; we just lack the
   *  capability to retrieve it). Caller SHOULD surface to user as a
   *  configuration error rather than a data-loss event. */
  | 'CID_REF_UNREADABLE'
  /** CidRef's declared size does not match the encrypted blob actually
   *  fetched from IPFS. Indicates either a crafted poisoned ref (hostile
   *  peer via LWW replication) or corruption. Fail-closed; do not decrypt. */
  | 'CID_REF_SIZE_MISMATCH';

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
