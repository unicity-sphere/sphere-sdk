/**
 * UXF extension error codes.
 *
 * These extend `SphereError`'s error-code union. Introduced as a stable set
 * in wave-1 (Phase 3) so consumers can pattern-match on `error.code` today;
 * real emission wires up in Phase 9's pipeline/bundle/profile ports.
 *
 * Naming: `UXF_<SUBSYSTEM>_<DETAIL>` — matches the existing convention
 * used across `modules/payments/transfer/*` (relocated in Phase 3.A step 2
 * to `extensions/uxf/pipeline/`).
 */

export const UXF_ERROR_CODES = {
  // Bundle format
  UXF_BUNDLE_MALFORMED: 'UXF_BUNDLE_MALFORMED',
  UXF_BUNDLE_UNSUPPORTED_VERSION: 'UXF_BUNDLE_UNSUPPORTED_VERSION',
  UXF_BUNDLE_UNKNOWN_KIND: 'UXF_BUNDLE_UNKNOWN_KIND',

  // Pipeline (transfer crash-safety)
  UXF_PIPELINE_NOT_ACTIVATED: 'UXF_PIPELINE_NOT_ACTIVATED',
  UXF_PIPELINE_OUTBOX_WRITE_FAILED: 'UXF_PIPELINE_OUTBOX_WRITE_FAILED',
  UXF_PIPELINE_SENT_WRITE_FAILED: 'UXF_PIPELINE_SENT_WRITE_FAILED',
  UXF_PIPELINE_DISPOSITION_CONFLICT: 'UXF_PIPELINE_DISPOSITION_CONFLICT',

  // Profile (durable substrate + pointer layer)
  UXF_PROFILE_NOT_ACTIVATED: 'UXF_PROFILE_NOT_ACTIVATED',
  UXF_PROFILE_POINTER_UNAVAILABLE: 'UXF_PROFILE_POINTER_UNAVAILABLE',
  UXF_PROFILE_SUBSTRATE_ERROR: 'UXF_PROFILE_SUBSTRATE_ERROR',

  // Extension lifecycle
  UXF_EXTENSION_NOT_INSTALLED: 'UXF_EXTENSION_NOT_INSTALLED',
  UXF_EXTENSION_ALREADY_INSTALLED: 'UXF_EXTENSION_ALREADY_INSTALLED',
} as const;

export type UxfErrorCode = (typeof UXF_ERROR_CODES)[keyof typeof UXF_ERROR_CODES];
