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
 */
function wrapPool(pkg: UxfPackageData): ElementPool {
  return ElementPool.fromMap(pkg.pool);
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
 */
export function ingestAll(pkg: UxfPackageData, tokens: unknown[]): void {
  for (const token of tokens) {
    ingest(pkg, token);
  }
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
 */
function mergePkg(target: UxfPackageData, source: UxfPackageData): void {
  const mutablePool = target.pool as Map<ContentHash, UxfElement>;
  const mutableManifest = target.manifest.tokens as Map<string, ContentHash>;

  // Re-hash and verify every incoming element (Decision 7)
  for (const [hash, element] of source.pool) {
    const recomputed = computeElementHash(element);
    if (recomputed !== hash) {
      throw new UxfError(
        'VERIFICATION_FAILED',
        `Hash mismatch for incoming element ${hash}: computed ${recomputed}`,
      );
    }
    // Dedup by hash: only insert if not already present
    if (!mutablePool.has(hash)) {
      mutablePool.set(hash, element);
    }
  }

  // Merge manifest: source entries win on collision
  for (const [tokenId, rootHash] of source.manifest.tokens) {
    mutableManifest.set(tokenId, rootHash);
  }

  // Merge instance chains (Decision 6)
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
