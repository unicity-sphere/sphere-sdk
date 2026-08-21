import type { InventoryView } from './inventory/InventoryView';
import type { StoragePort } from './ports';
import type { SpendQueue } from './select/queue';

/** Source blobs fetched ahead of a send, scoped to the state each token sat at (F6). */
export class PrewarmCache {
  private readonly entries = new Map<string, Uint8Array>();
  private generation = 0;

  private static key(tokenId: string, stateHash: string): string {
    return `${tokenId}:${stateHash}`;
  }

  /** Claim the cache for a warm about to start; supersedes any warm already running. */
  begin(): number {
    this.entries.clear();
    this.generation += 1;
    return this.generation;
  }

  /**
   * Publish a warm's result, unless it was cancelled or superseded while its
   * fetch was in flight — a cancel that only cleared what had landed so far
   * would be undone by the continuation of the very warm it cancelled.
   */
  commit(generation: number, warmed: readonly (readonly [string, string, Uint8Array])[]): void {
    if (generation !== this.generation) return;
    for (const [tokenId, stateHash, bytes] of warmed) {
      this.entries.set(PrewarmCache.key(tokenId, stateHash), bytes);
    }
  }

  get(tokenId: string, stateHash: string | undefined): Uint8Array | undefined {
    if (stateHash === undefined) return undefined;
    return this.entries.get(PrewarmCache.key(tokenId, stateHash));
  }

  clear(): void {
    this.entries.clear();
    this.generation += 1;
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface WarmDeps {
  readonly queue: SpendQueue;
  readonly view: Pick<InventoryView, 'stateHashOf' | 'delta'>;
  readonly storagePort: Pick<StoragePort, 'getBlobs'>;
  readonly cache: PrewarmCache;
}

/** Reserves nothing and throws nothing: the send re-fetches whatever is missing. */
export async function warmSendSources(
  deps: WarmDeps,
  request: { coinId: string; amount: string }
): Promise<void> {
  const ids = deps.queue.previewSelection(request);
  if (ids.length === 0) return;
  const generation = deps.cache.begin();
  const at = new Map(ids.map((id) => [id, deps.view.stateHashOf(id)]));
  let blobs: Map<string, Uint8Array>;
  try {
    blobs = await deps.storagePort.getBlobs([...ids]);
  } catch {
    return;
  }
  const warmed: (readonly [string, string, Uint8Array])[] = [];
  for (const [tokenId, bytes] of blobs) {
    const stateHash = at.get(tokenId);
    if (stateHash !== undefined) warmed.push([tokenId, stateHash, bytes]);
  }
  deps.cache.commit(generation, warmed);
}

/**
 * Warm where the token still sits at its warmed state; single-use. Refreshes the
 * mirror FIRST — warming and consuming both read `stateHashOf`, so they agree
 * even when the server has moved on, and the uncached path reads the server's
 * current blob. Unverifiable freshness re-fetches instead.
 */
export async function takeSourceBlobs(
  deps: Pick<WarmDeps, 'view' | 'storagePort' | 'cache'>,
  sourceIds: readonly string[]
): Promise<Map<string, Uint8Array>> {
  const blobs = new Map<string, Uint8Array>();
  const missing: string[] = [];
  let trustCache = deps.cache.size > 0;
  if (trustCache) {
    try {
      await deps.view.delta();
    } catch {
      trustCache = false;
    }
  }
  for (const tokenId of sourceIds) {
    const warm = trustCache ? deps.cache.get(tokenId, deps.view.stateHashOf(tokenId)) : undefined;
    if (warm === undefined) missing.push(tokenId);
    else blobs.set(tokenId, warm);
  }
  deps.cache.clear();
  if (missing.length > 0) {
    for (const [tokenId, bytes] of await deps.storagePort.getBlobs(missing)) {
      blobs.set(tokenId, bytes);
    }
  }
  return blobs;
}
