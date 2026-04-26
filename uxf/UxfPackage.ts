/**
 * UxfPackage Class (WU-08)
 *
 * The primary public interface wrapping UxfPackageData with a fluent,
 * mutation-friendly API. Methods mutate in place and return `this`
 * for chaining (builder pattern).
 *
 * Also exports free functions (functional API) that operate on raw
 * UxfPackageData for consumers who prefer a functional style.
 *
 * @module uxf/UxfPackage
 */

import type {
  ContentHash,
  UxfElement,
  UxfPackageData,
  UxfManifest,
  UxfEnvelope,
  UxfIndexes,
  UxfDelta,
  UxfVerificationResult,
  UxfStorageAdapter,
  InstanceSelectionStrategy,
  InstanceChainEntry,
  InstanceChainIndex,
  GenesisDataContent,
  StateContent,
  TokenRootContent,
  TokenRootChildren,
  GenesisChildren,
} from './types.js';
import { STRATEGY_LATEST } from './types.js';
import { UxfError } from './errors.js';
import { computeElementHash } from './hash.js';
import { ElementPool, collectGarbage, walkReachable } from './element-pool.js';
import {
  addInstance as addInstanceToChain,
  mergeInstanceChains,
  type MutableInstanceChainIndex,
} from './instance-chain.js';
import { deconstructToken } from './deconstruct.js';
import {
  assembleToken,
  assembleTokenAtState,
} from './assemble.js';
import { verify as verifyImpl } from './verify.js';
import { diff as diffImpl, applyDelta as applyDeltaImpl } from './diff.js';
import { packageToJson, packageFromJson } from './json.js';
import { exportToCar, importFromCar } from './ipld.js';
import { resolveTokenRoot } from './token-join.js';
import { logger } from '../core/logger.js';

// ---------------------------------------------------------------------------
// UxfPackage Class
// ---------------------------------------------------------------------------

/**
 * The primary public interface for UXF operations.
 * Wraps UxfPackageData with a fluent, mutation-friendly API.
 */
export class UxfPackage {
  private data: UxfPackageData;

  private constructor(data: UxfPackageData) {
    this.data = data;
  }

  // ---------- Static Factories ----------

  /**
   * Create a new empty package.
   */
  static create(options?: { description?: string; creator?: string }): UxfPackage {
    const now = Math.floor(Date.now() / 1000);
    const envelope: UxfEnvelope = {
      version: '1.0.0',
      createdAt: now,
      updatedAt: now,
      ...(options?.description !== undefined ? { description: options.description } : {}),
      ...(options?.creator !== undefined ? { creator: options.creator } : {}),
    };
    const data: UxfPackageData = {
      envelope,
      manifest: { tokens: new Map() },
      pool: new Map(),
      instanceChains: new Map(),
      indexes: {
        byTokenType: new Map(),
        byCoinId: new Map(),
        byStateHash: new Map(),
      },
    };
    return new UxfPackage(data);
  }

  /**
   * Load from storage adapter.
   */
  static async open(storage: UxfStorageAdapter): Promise<UxfPackage> {
    const data = await storage.load();
    if (!data) {
      throw new UxfError('INVALID_PACKAGE', 'No package found in storage');
    }
    return new UxfPackage(data);
  }

  /**
   * Deserialize from JSON.
   */
  static fromJson(json: string): UxfPackage {
    return new UxfPackage(packageFromJson(json));
  }

  /**
   * Deserialize from CAR bytes.
   */
  static async fromCar(car: Uint8Array): Promise<UxfPackage> {
    const data = await importFromCar(car);
    // Rebuild indexes from imported data since CAR import returns empty indexes
    rebuildIndexes(data);
    return new UxfPackage(data);
  }

  // ---------- Ingestion ----------

  /**
   * Deconstruct a token and add to the package.
   * If the token already exists, its manifest entry is updated to the new root.
   */
  ingest(token: unknown): this {
    ingest(this.data, token);
    return this;
  }

  /**
   * Batch ingest multiple tokens.
   */
  ingestAll(tokens: unknown[]): this {
    ingestAll(this.data, tokens);
    return this;
  }

  // ---------- Reassembly ----------

  /**
   * Reassemble a token at its latest state.
   * @returns Self-contained object matching the ITokenJson shape.
   */
  assemble(tokenId: string, strategy?: InstanceSelectionStrategy): unknown {
    return assemble(this.data, tokenId, strategy);
  }

  /**
   * Reassemble at a specific historical state.
   * stateIndex=0 -> genesis only. stateIndex=N -> genesis + first N transactions.
   */
  assembleAtState(
    tokenId: string,
    stateIndex: number,
    strategy?: InstanceSelectionStrategy,
  ): unknown {
    return assembleAtState(this.data, tokenId, stateIndex, strategy);
  }

  /**
   * Assemble all tokens in the manifest.
   */
  assembleAll(strategy?: InstanceSelectionStrategy): Map<string, unknown> {
    const result = new Map<string, unknown>();
    for (const tokenId of this.data.manifest.tokens.keys()) {
      result.set(tokenId, assemble(this.data, tokenId, strategy));
    }
    return result;
  }

  // ---------- Token Management ----------

  /**
   * Remove a token from the manifest.
   * Elements are NOT garbage-collected automatically -- call gc() explicitly.
   */
  removeToken(tokenId: string): this {
    removeToken(this.data, tokenId);
    return this;
  }

  /**
   * List all token IDs in the manifest.
   */
  tokenIds(): string[] {
    return [...this.data.manifest.tokens.keys()];
  }

  /**
   * Check if a token exists in the manifest.
   */
  hasToken(tokenId: string): boolean {
    return this.data.manifest.tokens.has(tokenId);
  }

  /**
   * Get the number of transactions for a token.
   * Resolves the token root element and returns its transactions array length.
   */
  transactionCount(tokenId: string): number {
    const rootHash = this.data.manifest.tokens.get(tokenId);
    if (!rootHash) {
      throw new UxfError('TOKEN_NOT_FOUND', `Token ${tokenId} not in manifest`);
    }
    const rootElement = this.data.pool.get(rootHash);
    if (!rootElement) {
      throw new UxfError('MISSING_ELEMENT', `Root element ${rootHash} not in pool`);
    }
    const children = rootElement.children as unknown as TokenRootChildren;
    return children.transactions.length;
  }

  // ---------- Instance Chains ----------

  /**
   * Append a new instance to an element's instance chain.
   */
  addInstance(originalHash: ContentHash, newInstance: UxfElement): this {
    addInstance(this.data, originalHash, newInstance);
    return this;
  }

  /**
   * Phase 2 -- throws NOT_IMPLEMENTED in Phase 1.
   */
  consolidateProofs(tokenId: string, txRange: [number, number]): void {
    consolidateProofs(this.data, tokenId, txRange);
  }

  // ---------- Package Operations ----------

  /**
   * Merge another package into this one.
   * Elements are deduplicated by content hash.
   * Manifest entries from the other package are added (or overwritten if tokenId collides).
   */
  merge(other: UxfPackage): this {
    mergePkg(this.data, other.data);
    return this;
  }

  /**
   * Compute the minimal delta between this package and another.
   */
  diff(other: UxfPackage): UxfDelta {
    return diffImpl(this.data, other.data);
  }

  /**
   * Apply a delta to this package.
   */
  applyDelta(delta: UxfDelta): this {
    applyDeltaImpl(this.data, delta);
    return this;
  }

  /**
   * Garbage-collect unreachable elements.
   * Returns the number of elements removed.
   */
  gc(): number {
    return collectGarbageFn(this.data);
  }

  // ---------- Verification ----------

  /**
   * Verify structural integrity of the package.
   */
  verify(): UxfVerificationResult {
    return verifyImpl(this.data);
  }

  // ---------- Queries ----------

  /**
   * Filter tokens by predicate.
   */
  filterTokens(predicate: (tokenId: string, rootElement: UxfElement) => boolean): string[] {
    const result: string[] = [];
    for (const [tokenId, rootHash] of this.data.manifest.tokens) {
      const rootElement = this.data.pool.get(rootHash);
      if (rootElement && predicate(tokenId, rootElement)) {
        result.push(tokenId);
      }
    }
    return result;
  }

  /**
   * Get tokens by coin ID (uses index).
   */
  tokensByCoinId(coinId: string): string[] {
    const set = this.data.indexes.byCoinId.get(coinId);
    return set ? [...set] : [];
  }

  /**
   * Get tokens by token type (uses index).
   */
  tokensByTokenType(tokenType: string): string[] {
    const set = this.data.indexes.byTokenType.get(tokenType);
    return set ? [...set] : [];
  }

  // ---------- Serialization ----------

  /**
   * Serialize to JSON string.
   */
  toJson(): string {
    return packageToJson(this.data);
  }

  /**
   * Export as CARv1 bytes.
   */
  async toCar(): Promise<Uint8Array> {
    return exportToCar(this.data);
  }

  /**
   * Save to storage adapter.
   */
  async save(storage: UxfStorageAdapter): Promise<void> {
    await storage.save(this.data);
  }

  // ---------- Statistics ----------

  /** Number of tokens in manifest. */
  get tokenCount(): number {
    return this.data.manifest.tokens.size;
  }

  /** Number of elements in pool. */
  get elementCount(): number {
    return this.data.pool.size;
  }

  /**
   * Estimated byte size (rough estimate based on element count).
   * Each element is roughly 500 bytes on average when CBOR-encoded.
   */
  get estimatedSize(): number {
    return this.data.pool.size * 500;
  }

  /** Get the underlying data (read-only). */
  get packageData(): Readonly<UxfPackageData> {
    return this.data;
  }
}

// ---------------------------------------------------------------------------
// Free Functions (Functional API)
// ---------------------------------------------------------------------------

/**
 * Wrap a raw UxfPackageData pool Map as an ElementPool instance.
 * Many internal functions require ElementPool rather than a plain Map.
 *
 * Steelman²⁸/²⁹/³⁰: this is a trust-boundary wrapper. The
 * UxfPackageData may have been constructed in-memory by trusted code OR
 * may be the post-deserialize result of attacker-supplied JSON/CAR. We
 * use the verifying variant (fromMapVerified) to catch any
 * key/element-hash inconsistency at the point of wrapping.
 *
 * Cost: one SHA-256 per element. Enforces WRAP_POOL_MAX_SIZE = 1M to
 * prevent bloat-DoS — separate from verify.ts's VERIFY_MAX_POOL_SIZE
 * which only applies inside verify().  Hot batch paths use ingestAll
 * which wraps once for the whole batch (steelman³⁰ ingestAll fix).
 */
const WRAP_POOL_MAX_SIZE = 1_000_000;
function wrapPool(pkg: UxfPackageData): ElementPool {
  if (pkg.pool.size > WRAP_POOL_MAX_SIZE) {
    throw new UxfError(
      'INVALID_PACKAGE',
      `wrapPool: pool size ${pkg.pool.size} exceeds WRAP_POOL_MAX_SIZE=${WRAP_POOL_MAX_SIZE} (bloat-DoS protection)`,
    );
  }
  return ElementPool.fromMapVerified(pkg.pool);
}

/**
 * Sync an ElementPool's contents back into a UxfPackageData pool Map.
 */
function syncPool(pkg: UxfPackageData, pool: ElementPool): void {
  const newMap = pool.toMap();
  const mutablePool = pkg.pool as Map<ContentHash, UxfElement>;
  mutablePool.clear();
  for (const [hash, element] of newMap) {
    mutablePool.set(hash, element);
  }
}

/**
 * Deconstruct a token and add it to the package.
 * Updates manifest and secondary indexes.
 */
export function ingest(pkg: UxfPackageData, token: unknown): void {
  const pool = wrapPool(pkg);
  const rootHash = deconstructToken(pool, token);
  syncPool(pkg, pool);

  // Extract tokenId from the root element
  const rootElement = pool.get(rootHash)!;
  const rootContent = rootElement.content as unknown as TokenRootContent;
  const tokenId = rootContent.tokenId;

  // Update manifest
  const mutableManifest = pkg.manifest.tokens as Map<string, ContentHash>;
  mutableManifest.set(tokenId, rootHash);

  // Update envelope timestamp
  (pkg.envelope as { updatedAt: number }).updatedAt = Math.floor(Date.now() / 1000);

  // Update secondary indexes
  updateIndexesForToken(pkg, tokenId, rootHash);
}

/**
 * Batch ingest multiple tokens.
 *
 * Steelman³⁰/³¹: wrap the pool ONCE for the whole batch (O(N) SHA-256
 * calls instead of O(N²)) AND defer manifest + index mutations until
 * AFTER syncPool. This fixes two F.35 regressions:
 *
 *   (a) Index breakage: updateIndexesForToken reads from pkg.pool,
 *       which doesn't have the new elements until syncPool runs.
 *       Pre-syncPool calls silently no-op'd, leaving byCoinId /
 *       byTokenType / byStateHash empty after batch ingest. None of
 *       the 38 UxfPackage tests asserted post-batch index content,
 *       so the regression shipped silently.
 *
 *   (b) Atomicity: manifest mutations during the loop made a partial
 *       failure leave the manifest pointing at rootHashes that DO NOT
 *       exist in the pool yet. Now: collect (tokenId, rootHash) pairs
 *       in a local list; commit pool + manifest + indexes only after
 *       the loop completes.
 */
export function ingestAll(pkg: UxfPackageData, tokens: unknown[]): void {
  if (tokens.length === 0) return;
  const pool = wrapPool(pkg);
  const newTokens: Array<{ tokenId: string; rootHash: ContentHash }> = [];
  for (const token of tokens) {
    const rootHash = deconstructToken(pool, token);
    const rootElement = pool.get(rootHash)!;
    const rootContent = rootElement.content as unknown as TokenRootContent;
    newTokens.push({ tokenId: rootContent.tokenId, rootHash });
    // Steelman³⁸ warning: re-check the cap AFTER each deconstruct.
    // wrapPool only checks the EXISTING pool size; without this gate
    // a single huge batch could bypass WRAP_POOL_MAX_SIZE entirely.
    if (pool.size > WRAP_POOL_MAX_SIZE) {
      throw new UxfError(
        'INVALID_PACKAGE',
        `ingestAll: pool size ${pool.size} exceeds WRAP_POOL_MAX_SIZE=${WRAP_POOL_MAX_SIZE} ` +
          `mid-batch (after ${newTokens.length} of ${tokens.length} tokens). Bloat-DoS protection.`,
      );
    }
  }
  // ATOMIC COMMIT: pool first (so updateIndexesForToken's pkg.pool.get
  // returns the newly-deconstructed elements), then manifest, then
  // indexes. If an earlier deconstructToken threw, we never reach here
  // and the package state is unchanged.
  //
  // Steelman³²/³³ warning: wrap the index loop in try/catch. Today
  // updateIndexesForToken is no-throw (silent if/return on missing
  // elements), but future changes could add throws — without the
  // catch, a partial commit would leave manifest pointing at tokens
  // whose indexes weren't built AND indexes pointing at tokens whose
  // manifest entries got rolled back. On throw, ROLL BACK both the
  // manifest entries AND the index entries we added.
  //
  // Steelman⁴⁸ WARNING: also snapshot the pre-existing pool keys so a
  // throw during the manifest/index loop can roll back any pool
  // entries inserted by `syncPool` above. Previously the docstring
  // claimed "atomic commit" but only manifest+indexes were rolled
  // back — orphan pool elements survived (would only be reclaimed by
  // gc()). True rollback now restores pool to its pre-syncPool state.
  const prePoolKeys = new Set<string>(pkg.pool.keys());
  syncPool(pkg, pool);
  const mutableManifest = pkg.manifest.tokens as Map<string, ContentHash>;
  const previousManifest = new Map<string, ContentHash | undefined>();
  for (const { tokenId } of newTokens) {
    previousManifest.set(tokenId, mutableManifest.get(tokenId));
  }
  const committedTokenIds: string[] = [];
  // Steelman³⁴ warning: track the IN-FLIGHT tokenId separately so a
  // partial throw inside updateIndexesForToken (which may have added
  // to byTokenType but not byCoinId before throwing) is also rolled
  // back. Without this, the failing token's partial index entries
  // leak even though its manifest mutation IS rolled back.
  let inFlightTokenId: string | undefined;
  try {
    for (const { tokenId, rootHash } of newTokens) {
      inFlightTokenId = tokenId;
      mutableManifest.set(tokenId, rootHash);
      updateIndexesForToken(pkg, tokenId, rootHash);
      committedTokenIds.push(tokenId);
      inFlightTokenId = undefined;
    }
  } catch (err) {
    // Roll back the indexes for tokens we already committed AND for
    // the in-flight token (whose updateIndexesForToken may have
    // partially mutated the indexes before throwing).
    if (inFlightTokenId !== undefined) {
      try { removeFromIndexes(pkg.indexes, inFlightTokenId); } catch { /* best-effort */ }
    }
    for (const tokenId of committedTokenIds) {
      try { removeFromIndexes(pkg.indexes, tokenId); } catch { /* best-effort */ }
    }
    // Roll back manifest mutations.
    for (const [tokenId, prev] of previousManifest) {
      if (prev === undefined) mutableManifest.delete(tokenId);
      else mutableManifest.set(tokenId, prev);
    }
    // Steelman⁴⁸: roll back pool inserts to satisfy the "atomic
    // commit" docstring contract. Delete any element added by
    // syncPool that wasn't in the pre-existing key set.
    const mutablePool = pkg.pool as Map<ContentHash, UxfElement>;
    for (const key of [...mutablePool.keys()]) {
      if (!prePoolKeys.has(key)) {
        try { mutablePool.delete(key); } catch { /* best-effort */ }
      }
    }
    throw err;
  }
  (pkg.envelope as { updatedAt: number }).updatedAt = Math.floor(Date.now() / 1000);
}

/**
 * Reassemble a token at its latest state.
 */
export function assemble(
  pkg: UxfPackageData,
  tokenId: string,
  strategy: InstanceSelectionStrategy = STRATEGY_LATEST,
): unknown {
  const pool = wrapPool(pkg);
  return assembleToken(pool, pkg.manifest, tokenId, pkg.instanceChains, strategy);
}

/**
 * Reassemble at a specific historical state.
 */
export function assembleAtState(
  pkg: UxfPackageData,
  tokenId: string,
  stateIndex: number,
  strategy: InstanceSelectionStrategy = STRATEGY_LATEST,
): unknown {
  const pool = wrapPool(pkg);
  return assembleTokenAtState(
    pool,
    pkg.manifest,
    tokenId,
    stateIndex,
    pkg.instanceChains,
    strategy,
  );
}

/**
 * Remove a token from the manifest and all indexes.
 * Does NOT garbage-collect elements.
 */
export function removeToken(pkg: UxfPackageData, tokenId: string): void {
  const mutableManifest = pkg.manifest.tokens as Map<string, ContentHash>;
  mutableManifest.delete(tokenId);

  // Remove from all secondary indexes
  removeFromIndexes(pkg.indexes, tokenId);

  // Update envelope timestamp
  (pkg.envelope as { updatedAt: number }).updatedAt = Math.floor(Date.now() / 1000);
}

/**
 * Merge another package's elements and manifest into this one.
 *
 * For each element in source.pool, re-hash via computeElementHash() and
 * verify the hash matches its key before inserting (Decision 7).
 * Manifest entries from source are added (or overwritten if tokenId collides).
 * Instance chains are merged per Decision 6.
 * Secondary indexes are rebuilt from scratch.
 *
 * ------------------------------------------------------------------
 * Per-token atomicity contract
 * ------------------------------------------------------------------
 *
 * The merge is **per-token atomic** rather than whole-merge atomic:
 *   - Whole-bundle pool verification (Decision 7) is a fast-fail
 *     gate. If ANY source pool element fails its hash re-check, the
 *     entire merge aborts and target state is unchanged — a corrupt
 *     pool is a whole-bundle integrity failure and cannot be
 *     localised to a single tokenId.
 *   - Once the pool verifies, each source manifest entry is
 *     processed independently. If `resolveTokenRoot` throws for
 *     tokenId N (e.g. `computeElementHash` rejects a malformed
 *     child inside a Rule 4 synthetic rebuild), the failure is
 *     logged via `logger.warn('UxfPackage', …)` citing tokenId +
 *     error, and iteration CONTINUES for the remaining tokenIds.
 *     One poisoned entry must not deny the user their good tokens.
 *
 * Implementation:
 *   1. Stage the pool-verify pass into a proposed-inserts map
 *      without touching target.pool.
 *   2. Build a temporary "virtual pool" (target.pool ∪ stagedPool)
 *      that the resolver can read through, without any commits.
 *   3. For each source manifest entry: invoke the resolver, stage
 *      its manifest write + any Rule 4 synthetic root insert. Skip
 *      on throw.
 *   4. Apply all staged writes to target.pool and target.manifest
 *      atomically (synchronous Map.set calls — no I/O inside the
 *      apply phase).
 *
 * Pool-rollback policy for partially-merged tokens:
 *
 *   Source pool elements are retained even when the owning source
 *   manifest entry was skipped on a resolver throw. Rationale:
 *     - The pool is content-addressed. Duplicate keys are no-ops;
 *       unused pool growth is bounded at roughly ~500 bytes per
 *       orphaned element and removed by `gc()` on demand.
 *     - Transaction / state / predicate elements authored for a
 *       skipped tokenId may be legitimately referenced by a
 *       surviving tokenId's instance chain (shared nametag tokens,
 *       shared predicates). A reachability-aware rollback would
 *       have to re-implement `walkReachable` + set arithmetic on
 *       the staged inserts — needless complexity for cheap bloat.
 *     - GC is already the documented contract for pruning
 *       unreachable elements after `removeToken` / partial imports.
 *
 * Multi-source (3+ candidate) refactor note (W3):
 *
 *   `resolveTokenRoot`'s `divergent` outcome is whole-set when
 *   candidates ≥ 3: if any pair diverges the whole tokenId falls
 *   into `divergent`. Today mergePkg is strictly 2-candidate
 *   (existingRoot + incomingRoot) so this is latent. A future
 *   multi-source JOIN (merging K ≥ 2 source bundles in one pass)
 *   should either (a) fold sources pairwise with this 2-candidate
 *   resolver, accepting that pairwise JOIN is not associative for
 *   the `divergent` case, or (b) extend the resolver to return a
 *   compatibility partition and pick the majority class. Leave the
 *   refactor — just documenting.
 */
function mergePkg(target: UxfPackageData, source: UxfPackageData): void {
  const mutablePool = target.pool as Map<ContentHash, UxfElement>;
  const mutableManifest = target.manifest.tokens as Map<string, ContentHash>;

  // ---- Phase 1: stage pool inserts with whole-bundle hash verify ----
  //
  // Decision 7 — every incoming element's hash must match its key.
  // A failure here is a whole-bundle corruption and aborts the
  // merge before ANY target state is touched.
  const stagedPoolInserts = new Map<ContentHash, UxfElement>();
  for (const [hash, element] of source.pool) {
    const recomputed = computeElementHash(element);
    if (recomputed !== hash) {
      throw new UxfError(
        'VERIFICATION_FAILED',
        `Hash mismatch for incoming element ${hash}: computed ${recomputed}`,
      );
    }
    // Dedup by hash: only stage if target doesn't already have it.
    if (!mutablePool.has(hash)) {
      stagedPoolInserts.set(hash, element);
    }
  }

  // Virtual read-only pool view: target ∪ staged inserts. The
  // resolver reads through `get`; a plain Map union is simpler
  // than a proxy and correct for this call path.
  const virtualPool: ReadonlyMap<ContentHash, UxfElement> = new Map([
    ...mutablePool,
    ...stagedPoolInserts,
  ]);

  // ---- Phase 2: stage per-token manifest writes + synthetic inserts ----
  //
  // Each source manifest entry is processed in a try/catch so one
  // poisoned tokenId (resolver throws from e.g. Rule 4
  // `computeElementHash` rejecting a malformed child) does not
  // abort the merge for the other tokens.
  const stagedManifestWrites = new Map<string, ContentHash>();
  const stagedSyntheticInserts = new Map<ContentHash, UxfElement>();

  for (const [tokenId, incomingRoot] of source.manifest.tokens) {
    try {
      const existingRoot = mutableManifest.get(tokenId);
      if (existingRoot === undefined) {
        stagedManifestWrites.set(tokenId, incomingRoot);
        continue;
      }
      if (existingRoot === incomingRoot) {
        continue;
      }
      // Per-token JOIN resolver (Rules 3 + 4 of §10.4).
      // Deterministic for a given (tokenId, candidates, pool).
      const outcome = resolveTokenRoot({
        tokenId,
        candidates: [existingRoot, incomingRoot],
        pool: virtualPool,
      });
      // Rule 4: a synthetic proof-enriched TokenRoot must be
      // inserted into the pool under the resolver's returned
      // rootHash so the manifest's ref is resolvable. The resolver
      // is pure (does not touch the pool) — the insert is the
      // caller's responsibility here.
      if (outcome.kind === 'enriched') {
        stagedSyntheticInserts.set(outcome.rootHash, outcome.syntheticRoot);
      }
      stagedManifestWrites.set(tokenId, outcome.rootHash);
    } catch (err) {
      // One poisoned tokenId must not abort the whole merge.
      // Skip this entry, log it for telemetry / operator review,
      // and continue. Target state for this tokenId stays at its
      // pre-merge value (whatever `mutableManifest.get(tokenId)`
      // was — possibly undefined, i.e. the entry is simply
      // absent from the merged manifest).
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(
        'UxfPackage',
        `mergePkg: skipping tokenId ${tokenId} — resolver threw: ${message}`,
      );
    }
  }

  // ---- Phase 3: atomic apply ----
  //
  // Synchronous Map.set calls. No I/O, no throws in this block —
  // all inputs were validated during staging. If ANY of the
  // following stages throws (indicating a programmer error, not
  // data corruption) the target is partially mutated and the
  // caller should treat the package as tainted. This is the
  // narrowest window possible given the API shape.
  for (const [hash, element] of stagedPoolInserts) {
    mutablePool.set(hash, element);
  }
  for (const [hash, syntheticRoot] of stagedSyntheticInserts) {
    mutablePool.set(hash, syntheticRoot);
  }
  for (const [tokenId, rootHash] of stagedManifestWrites) {
    mutableManifest.set(tokenId, rootHash);
  }

  // Merge instance chains (Decision 6). Operates on the committed
  // target pool and mutates target.instanceChains in place. If this
  // throws, per-token manifest writes above have already committed
  // — but instance-chain merging is defensively pool-driven and a
  // throw here indicates a programmer error rather than a
  // data-shape failure. Not wrapping.
  const targetPool = wrapPool(target);
  mergeInstanceChains(
    target.instanceChains as MutableInstanceChainIndex,
    source.instanceChains,
    targetPool,
  );

  // Rebuild secondary indexes from scratch (simplest correct approach)
  rebuildIndexes(target);

  // Update envelope timestamp
  (target.envelope as { updatedAt: number }).updatedAt = Math.floor(Date.now() / 1000);
}

/**
 * Merge another package's elements and manifest into this one.
 */
export { mergePkg as merge };

/**
 * Compute the minimal delta between two packages.
 */
export { diffImpl as diff };

/**
 * Apply a delta to a package.
 */
export { applyDeltaImpl as applyDelta };

/**
 * Verify structural integrity of the package.
 */
export { verifyImpl as verify };

/**
 * Append a new instance to an element's instance chain.
 */
export function addInstance(
  pkg: UxfPackageData,
  originalHash: ContentHash,
  newInstance: UxfElement,
): void {
  const pool = wrapPool(pkg);
  addInstanceToChain(
    pool,
    pkg.instanceChains as MutableInstanceChainIndex,
    originalHash,
    newInstance,
  );
  syncPool(pkg, pool);
}

/**
 * Phase 2 -- throws NOT_IMPLEMENTED in Phase 1.
 */
export function consolidateProofs(
  _pkg: UxfPackageData,
  _tokenId: string,
  _txRange: [number, number],
): void {
  throw new UxfError(
    'NOT_IMPLEMENTED',
    'consolidateProofs is not implemented in Phase 1 (Decision 9)',
  );
}

/**
 * Garbage-collect unreachable elements.
 * Returns the count of elements removed.
 */
export function collectGarbageFn(pkg: UxfPackageData): number {
  const removed = collectGarbage(pkg);
  return removed.size;
}

// Re-export as `collectGarbage` for the barrel export
export { collectGarbageFn as collectGarbage };

// Re-export packageToJson and packageFromJson for barrel
export { packageToJson, packageFromJson } from './json.js';

// ---------------------------------------------------------------------------
// Secondary Index Helpers
// ---------------------------------------------------------------------------

/**
 * Update secondary indexes for a single token after ingestion.
 */
function updateIndexesForToken(
  pkg: UxfPackageData,
  tokenId: string,
  rootHash: ContentHash,
): void {
  const rootElement = pkg.pool.get(rootHash);
  if (!rootElement) return;

  const rootChildren = rootElement.children as unknown as TokenRootChildren;

  // Extract genesis data for tokenType and coinId
  const genesisHash = rootChildren.genesis;
  const genesisElement = pkg.pool.get(genesisHash);
  if (genesisElement) {
    const genesisChildren = genesisElement.children as unknown as GenesisChildren;
    const genesisDataElement = pkg.pool.get(genesisChildren.data);
    if (genesisDataElement) {
      const genesisData = genesisDataElement.content as unknown as GenesisDataContent;

      // Index by tokenType
      if (genesisData.tokenType) {
        const mutableByTokenType = pkg.indexes.byTokenType as Map<string, Set<string>>;
        let typeSet = mutableByTokenType.get(genesisData.tokenType);
        if (!typeSet) {
          typeSet = new Set();
          mutableByTokenType.set(genesisData.tokenType, typeSet);
        }
        typeSet.add(tokenId);
      }

      // Index by coinId (from coinData[0][0])
      if (genesisData.coinData && genesisData.coinData.length > 0) {
        const coinId = genesisData.coinData[0][0];
        if (coinId) {
          const mutableByCoinId = pkg.indexes.byCoinId as Map<string, Set<string>>;
          let coinSet = mutableByCoinId.get(coinId);
          if (!coinSet) {
            coinSet = new Set();
            mutableByCoinId.set(coinId, coinSet);
          }
          coinSet.add(tokenId);
        }
      }
    }
  }

  // Index by current state hash
  const stateHash = rootChildren.state;
  const stateElement = pkg.pool.get(stateHash);
  if (stateElement) {
    const stateContent = stateElement.content as unknown as StateContent;
    // Use the state data as the state hash key
    if (stateContent.data) {
      const mutableByStateHash = pkg.indexes.byStateHash as Map<string, string>;
      mutableByStateHash.set(stateContent.data, tokenId);
    }
  }
}

/**
 * Remove a token from all secondary indexes.
 */
function removeFromIndexes(indexes: UxfIndexes, tokenId: string): void {
  // Remove from byTokenType
  const mutableByTokenType = indexes.byTokenType as Map<string, Set<string>>;
  for (const [key, set] of mutableByTokenType) {
    (set as Set<string>).delete(tokenId);
    if (set.size === 0) {
      mutableByTokenType.delete(key);
    }
  }

  // Remove from byCoinId
  const mutableByCoinId = indexes.byCoinId as Map<string, Set<string>>;
  for (const [key, set] of mutableByCoinId) {
    (set as Set<string>).delete(tokenId);
    if (set.size === 0) {
      mutableByCoinId.delete(key);
    }
  }

  // Remove from byStateHash
  const mutableByStateHash = indexes.byStateHash as Map<string, string>;
  for (const [key, value] of mutableByStateHash) {
    if (value === tokenId) {
      mutableByStateHash.delete(key);
    }
  }
}

/**
 * Rebuild all secondary indexes from scratch by scanning the manifest
 * and resolving each token's genesis data.
 */
function rebuildIndexes(pkg: UxfPackageData): void {
  // Clear all existing indexes
  const mutableByTokenType = pkg.indexes.byTokenType as Map<string, Set<string>>;
  const mutableByCoinId = pkg.indexes.byCoinId as Map<string, Set<string>>;
  const mutableByStateHash = pkg.indexes.byStateHash as Map<string, string>;

  mutableByTokenType.clear();
  mutableByCoinId.clear();
  mutableByStateHash.clear();

  // Rebuild from manifest
  for (const [tokenId, rootHash] of pkg.manifest.tokens) {
    updateIndexesForToken(pkg, tokenId, rootHash);
  }
}
