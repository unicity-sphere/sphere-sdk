/**
 * modules/payments/hooks.ts — extension seam interface.
 *
 * Formalizes the 20+ `install*()` methods on PaymentsModule into one
 * typed hook registry that the UXF extension plugs into. Per
 * uxfv2-refactor-design.md §2.1 and §4.3.
 *
 * The core PaymentsModule facade owns an instance of `PaymentsHooksHost`
 * and exposes the port for registration. Extensions register handlers
 * during their `activate(host)` phase. All events / callouts from the
 * core into the extension go through this surface — no direct imports
 * of `extensions/uxf/` from `modules/payments/` after Phase 6.C.
 *
 * Phase 5 lands the surface as a stub. Phase 6.C removes the pre-
 * existing `install*` methods from the facade and hooks the extension
 * through this interface.
 */

// NOTE (Phase 5): the concrete port types will crystallize during the
// dispatch/publish/OUTBOX/SENT/ingest-pool/worker migrations. For now
// this file serves as an anchor point — types imported by `PaymentsModule.ts`
// so the file exists in the reviewed structure. Actual body TBD in
// per-concern Phase 5 PRs.

export interface PaymentsHooksHost {
  /**
   * Reserved. Phase 6.C will populate with (a) inboundClaim (extension
   * peeks incoming raw payloads before dispatch), (b) preSendIntercept
   * (extension may divert a send() request onto its own pipeline), (c)
   * repositoryObserver (extension gets notified of token repository
   * writes), (d) workerAbortSignal (extension workers share the facade's
   * abort signal for uniform shutdown).
   */
  readonly _placeholder?: never;
}

export function createPaymentsHooksHost(): PaymentsHooksHost {
  return {};
}
