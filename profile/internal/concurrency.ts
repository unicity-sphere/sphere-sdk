/**
 * Bounded-concurrency parallel map.
 *
 * Issue #360 Finding #5 — used by the CAR-fetching paths
 * ({@link profile/profile-token-storage-provider.ts} JOIN load,
 * {@link profile/consolidation.ts} merge, and
 * {@link profile/ipfs-client.ts} `fetchCarFromIpfs` BFS frontier) to
 * fetch multiple IPFS objects in parallel without uncapped fan-out.
 *
 * Semantics:
 *   - Returns results in the SAME order as `items` (output[i] corresponds
 *     to input[i]).
 *   - Cap is bounded to `[1, items.length]`. A cap >= items.length runs
 *     all items in parallel (equivalent to `Promise.all`).
 *   - Non-finite or non-positive `limit` values clamp to 1.
 *   - `fn` rejections propagate via `Promise.all`. Like the pin-pool
 *     worker model used by `pinCarBlocksToIpfs`, every spawned worker
 *     is awaited even when one fails, so no UnhandledPromiseRejection
 *     escapes.
 *   - Callers that want per-item error tolerance should wrap `fn`
 *     to return `{ ok: true, value } | { ok: false, error }` themselves.
 */
export async function runWithConcurrency<T, R>(
  items: ReadonlyArray<T>,
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const effective = Math.max(
    1,
    Math.min(
      items.length,
      Number.isFinite(limit) ? Math.floor(limit) : 1,
    ),
  );
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let aborted = false;
  const workerErrors: unknown[] = [];

  const worker = async (): Promise<void> => {
    while (!aborted) {
      // V8 single-threaded read+write of `nextIndex++` is atomic — no
      // microtask interleaves between read and write. Mirrors the
      // pattern used by `pinCarBlocksToIpfs`.
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        aborted = true;
        throw err;
      }
    }
  };

  const workers: Promise<void>[] = [];
  for (let w = 0; w < effective; w++) {
    workers.push(
      worker().catch((err: unknown) => {
        workerErrors.push(err);
      }),
    );
  }
  await Promise.all(workers);

  if (workerErrors.length > 0) {
    throw workerErrors[0];
  }
  return results;
}
