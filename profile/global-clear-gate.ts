/**
 * profile/global-clear-gate.ts — process-wide gate consulted by
 * `ProfileTokenStorageProvider._applySnapshotIfWiredImpl` to suppress
 * snapshot dispatch during multi-wallet `Sphere.clear()` sequences.
 *
 * # Why a separate module
 *
 * Item #2 (issue #364) ships the per-instance `isClearing` latch on
 * `ProfileTokenStorageProvider`. It correctly suppresses
 * `applySnapshotIfWired` for THE provider whose `clear()` is in flight.
 * It does NOT cover the multi-wallet workflow where `Sphere.clear()` is
 * invoked sequentially across several wallets in the same process (or
 * where multi-wallet apps like sphere.telco have many providers running
 * concurrently): while wallet A is being cleared, wallets B/C/D's
 * periodic pointer-polls keep firing `applySnapshotIfWired` against
 * state that is about to be wiped when their own `clear()` runs next.
 *
 * Putting the state on `ProfileTokenStorageProvider` as a class-static
 * would couple `core/Sphere.ts` directly to the provider class. A small
 * dedicated module keeps the dependency direction clean: both
 * `core/Sphere.ts` and `profile/profile-token-storage-provider.ts`
 * import this leaf module.
 *
 * # Semantics
 *
 *   - Reference counted, not boolean. Multiple orchestrators (a batch
 *     wrapper AND the per-call `Sphere.clear()` body) may bracket the
 *     same range; both increments and the matching decrements compose.
 *   - {@link endGlobalClear} is no-op-safe when the depth is already 0
 *     so a stray double-end can't push the counter negative.
 *   - Process-scoped — there is one counter per JS realm. Cross-process
 *     coordination is not in scope (each process is its own clear; the
 *     filesystem/IndexedDB locks already serialize cross-process
 *     wallet wipes).
 *
 * # Usage
 *
 * ```ts
 * import { beginGlobalClear, endGlobalClear } from './global-clear-gate';
 *
 * beginGlobalClear();
 * try {
 *   // existing destructive sequence …
 * } finally {
 *   endGlobalClear();
 * }
 * ```
 *
 * @module profile/global-clear-gate
 * @see profile/profile-token-storage-provider.ts:_applySnapshotIfWiredImpl
 * @see core/Sphere.ts:Sphere.clear
 */

let depth = 0;

/**
 * Increment the process-wide global-clear depth. MUST be paired with
 * {@link endGlobalClear} in a `try/finally`. Idempotent on the
 * increment side — nesting composes.
 */
export function beginGlobalClear(): void {
  depth += 1;
}

/**
 * Decrement the process-wide global-clear depth. No-op-safe when the
 * depth is already 0 — a stray extra-end is harmless rather than
 * negative-going corruption.
 */
export function endGlobalClear(): void {
  if (depth > 0) {
    depth -= 1;
  }
}

/**
 * Read the current process-wide global-clear depth. Returns `true`
 * whenever at least one orchestrator currently holds the bracket.
 * Exposed for tests and operator surfaces; production callers should
 * use {@link beginGlobalClear} / {@link endGlobalClear} rather than
 * polling.
 */
export function isGlobalClearActive(): boolean {
  return depth > 0;
}

/**
 * Test-only — reset the counter to 0. Other production paths must NOT
 * call this; the begin/end protocol is the public contract. Tests
 * occasionally need a hard reset to recover from a failure that left
 * a bracket unclosed.
 */
export function __resetGlobalClearForTest(): void {
  depth = 0;
}
