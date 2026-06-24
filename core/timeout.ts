/**
 * Abort / timeout signal helpers.
 *
 * Kept in a dedicated, dependency-free module (no node:crypto fallback like
 * core/utils.ts) so importing it never pulls a Node builtin into the
 * browser-platform bundles (impl/browser/*, impl/shared/wallet-api).
 */

/**
 * Create an {@link AbortSignal} that aborts after `ms` milliseconds.
 *
 * Prefers the native `AbortSignal.timeout` (Chrome 103+, Firefox 100+,
 * Safari 16+ / iOS 16+). Falls back to an `AbortController` + `setTimeout` on
 * runtimes that lack it — older mobile Safari (iOS 15), older Android WebViews,
 * and in-app/embedded browsers — which would otherwise throw
 * `AbortSignal.timeout is not a function` the moment a timed fetch or engine
 * op runs (sphere-sdk#617: Swap / Top Up crash). The native fast-path is kept
 * for modern runtimes; the fallback aborts with a `TimeoutError` to match
 * native semantics.
 */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => {
    controller.abort(
      typeof DOMException !== 'undefined'
        ? new DOMException('The operation timed out.', 'TimeoutError')
        : new Error('The operation timed out.'),
    );
  }, ms);
  return controller.signal;
}
