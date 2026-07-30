/**
 * The read side of the wallet's holdings: the token-key derivation cache, the
 * balance/asset aggregation, the token read accessors, the tombstone set and
 * the engine `validate()` sweep.
 *
 * The token map itself and `save()` stay in PaymentsModule — this view READS
 * the map through {@link TokenViewHost} and never mutates it, so the module
 * keeps exactly one writer.
 */

import type { Asset, Token, TokenStatus } from '../../../types';
import type { TombstoneEntry, TxfToken } from '../../../types/txf';
import type { PriceProvider } from '../../../price';
import type { PaymentsModuleDependencies } from '../PaymentsModule';
import { TokenRegistry } from '../../../registry';
import { logger } from '../../../core/logger';
import { sha256, bytesToHex, hexToBytes } from '../../../core/crypto';
import { decodeTokenBlob } from '../../../token-engine/token-blob';

// =============================================================================
// Token key derivation (tokenId / stateHash) + its parse cache
// =============================================================================

/**
 * Current state hash of a stored v1 TXF relic, for tombstone dedup only.
 *
 * Inlined when the v1 serializer went: this is the one caller left, and it reads
 * the same four places the serializer did — last transaction, its proof, the
 * integrity block, then the genesis proof.
 */
function currentStateHashOfTxf(txf: TxfToken): string {
  const last = txf.transactions?.[txf.transactions.length - 1];
  return (
    last?.newStateHash ??
    last?.inclusionProof?.authenticator?.stateHash ??
    txf._integrity?.currentStateHash ??
    txf.genesis?.inclusionProof?.authenticator?.stateHash ??
    ''
  );
}

// Cache parsed sdkData fields to avoid repeated JSON.parse in hot loops.
// Key = sdkData string reference, value = { tokenId, stateHash }.
// Cleared on address switch via clearSdkDataCache().
// LOCAL-namespace keys ONLY (journal/tombstone dedup): this stateHash is a
// plain sha256 over the token bytes — it is NOT the protocol state hash the
// backend uses (that is token-engine deriveDeliveryKeys / the SDK imprint).
// Both writers and readers of these keys use THIS function; never mix the two
// derivations in one comparison.
const sdkDataCache = new Map<string, { tokenId: string | null; stateHash: string }>();
const SDK_DATA_CACHE_MAX = 2000;

/** A v2 engine blob is hex (CBOR); legacy v1 TXF is JSON (starts with '{'). */
export function looksLikeTokenBlob(sdkData: string): boolean {
  return sdkData.length >= 2 && sdkData.length % 2 === 0 && sdkData[0] !== '{' && /^[0-9a-f]+$/i.test(sdkData);
}

/**
 * Extract keys from a v2 engine blob (hex of CBOR(TokenBlob)). The blob carries
 * its genesis-stable tokenId; the per-state hash is SHA-256 of the token bytes
 * (unique per state — it changes on every transfer). No engine needed.
 * Returns null when the string is not a decodable blob.
 */
function tryParseBlobKeys(sdkData: string): { tokenId: string; stateHash: string } | null {
  try {
    const blob = decodeTokenBlob(hexToBytes(sdkData));
    return { tokenId: blob.tokenId, stateHash: sha256(bytesToHex(blob.token), 'hex') };
  } catch {
    return null;
  }
}

function parseSdkDataCached(sdkData: string): { tokenId: string | null; stateHash: string } {
  const cached = sdkDataCache.get(sdkData);
  if (cached) return cached;

  // v2 engine blob: self-describing keys (no engine, no JSON).
  let entry: { tokenId: string | null; stateHash: string } | null =
    looksLikeTokenBlob(sdkData) ? tryParseBlobKeys(sdkData) : null;

  if (!entry) {
    // NOT a v1 feature: tombstone/journal dedup is storage-level and
    // version-agnostic, keyed by (tokenId, stateHash). This branch derives those
    // keys for any non-blob stored shape — including the legacy TXF JSON still
    // sitting in old wallets — so a re-delivery can still be deduped. It stays
    // after the v1 removal deliberately; losing it would silently weaken dedup.
    let tokenId: string | null = null;
    let stateHash = '';
    try {
      const txf = JSON.parse(sdkData);
      tokenId = txf.genesis?.data?.tokenId || null;
      stateHash = currentStateHashOfTxf(txf as TxfToken);

      // Try alternative locations if not found in standard place
      if (!stateHash) {
        /* eslint-disable @typescript-eslint/no-explicit-any */
        if ((txf as any).state?.hash) {
          stateHash = (txf as any).state.hash;
        } else if ((txf as any).stateHash) {
          stateHash = (txf as any).stateHash;
        } else if ((txf as any).currentStateHash) {
          stateHash = (txf as any).currentStateHash;
        }
        /* eslint-enable @typescript-eslint/no-explicit-any */
      }
    } catch {
      // Invalid JSON — return defaults
    }
    entry = { tokenId, stateHash };
  }

  // Evict cache if it grows too large (unlikely in normal usage)
  if (sdkDataCache.size >= SDK_DATA_CACHE_MAX) {
    sdkDataCache.clear();
  }
  sdkDataCache.set(sdkData, entry);
  return entry;
}

function clearSdkDataCache(): void {
  sdkDataCache.clear();
}

/**
 * Extract token ID (genesis tokenId) from sdkData/jsonData
 */
export function extractTokenIdFromSdkData(sdkData: string | undefined): string | null {
  if (!sdkData) return null;
  return parseSdkDataCached(sdkData).tokenId;
}

/**
 * Extract state hash from sdkData/jsonData
 */
export function extractStateHashFromSdkData(sdkData: string | undefined): string {
  if (!sdkData) return '';
  return parseSdkDataCached(sdkData).stateHash;
}

/**
 * Create composite key from tokenId and stateHash
 * Format: {tokenId}_{stateHash}
 * This uniquely identifies a token at a specific state
 */
export function createTokenStateKey(tokenId: string, stateHash: string): string {
  return `${tokenId}_${stateHash}`;
}

/**
 * Extract composite key (tokenId_stateHash) from token
 * Returns null if token doesn't have valid tokenId and stateHash
 */
export function extractTokenStateKey(token: Token): string | null {
  const tokenId = extractTokenIdFromSdkData(token.sdkData);
  const stateHash = extractStateHashFromSdkData(token.sdkData);
  if (!tokenId || !stateHash) return null;
  return createTokenStateKey(tokenId, stateHash);
}

/**
 * Prune tombstones by age and count
 */
function pruneTombstonesByAge(
  tombstones: TombstoneEntry[],
  maxAge: number = 30 * 24 * 60 * 60 * 1000,
  maxCount: number = 100
): TombstoneEntry[] {
  const now = Date.now();
  let result = tombstones.filter(t => (now - t.timestamp) < maxAge);

  if (result.length > maxCount) {
    result = [...result].sort((a, b) => b.timestamp - a.timestamp);
    result = result.slice(0, maxCount);
  }

  return result;
}

/** Running per-coin totals folded by {@link TokenView.aggregateTokens}. */
interface AssetAccumulator {
  coinId: string;
  symbol: string;
  name: string;
  decimals: number;
  iconUrl?: string;
  confirmedAmount: bigint;
  unconfirmedAmount: bigint;
  transferringAmount: bigint;
  confirmedTokenCount: number;
  unconfirmedTokenCount: number;
  transferringTokenCount: number;
}

/**
 * The exact PaymentsModule members this feature reaches back for. Deliberately
 * narrow: the token map arrives as a READ-ONLY view and `save()` is a thunk —
 * the view never becomes a second writer of the module's core state.
 */
export interface TokenViewHost {
  /** Live dependency handle (identity / storage / tokenEngine); null before initialize(). */
  readonly deps: PaymentsModuleDependencies | null;
  /** The module's price provider — set from `deps.price` / `setPriceProvider()`. */
  readonly priceProvider: PriceProvider | null;
  /** Throws unless the module has dependencies. */
  ensureInitialized(): void;
  /** The live token map, read-only (the module owns every mutation). */
  getHeldTokens(): ReadonlyMap<string, Token>;
  /** Whether the price provider is switched off via `disabledProviderIds`. */
  isPriceDisabled(): boolean;
  /** Drop one entry from the spend-queue's parsed-token cache (an invalidated token). */
  deleteParsedToken(tokenId: string): void;
  /** Persist the module's state to the token storage providers. */
  save(): Promise<void>;
}

export class TokenView {
  // Repository State (tombstones)
  private tombstones: TombstoneEntry[] = [];
  // O(1) lookup set derived from tombstones array. Rebuilt via rebuildTombstoneKeySet().
  private tombstoneKeySet: Set<string> = new Set();

  constructor(private readonly host: TokenViewHost) {}

  /** Reset per-address read state (address switch) — the parse cache and the tombstones. */
  initialize(): void {
    clearSdkDataCache();
    this.tombstones = [];
    this.tombstoneKeySet.clear();
  }

  // ===========================================================================
  // Balance & Tokens
  // ===========================================================================

  /**
   * Get total portfolio value in USD.
   * Returns null if PriceProvider is not configured.
   */
  async getFiatBalance(): Promise<number | null> {
    const assets = await this.getAssets();

    if (!this.host.priceProvider || this.host.isPriceDisabled()) {
      return null;
    }

    let total = 0;
    let hasAnyPrice = false;

    for (const asset of assets) {
      if (asset.fiatValueUsd != null) {
        total += asset.fiatValueUsd;
        hasAnyPrice = true;
      }
    }

    return hasAnyPrice ? total : null;
  }

  /**
   * Get token balances grouped by coin type.
   *
   * Returns an array of {@link Asset} objects, one per coin type held.
   * Each entry includes confirmed and unconfirmed breakdowns. `'spent'` and
   * `'invalid'` tokens are excluded entirely. In-flight (`'transferring'`)
   * tokens are NOT counted toward the spendable balance (`totalAmount`,
   * `confirmedAmount`, `unconfirmedAmount`) — they are reported only in the
   * `transferring*` fields (#517 item 3).
   *
   * This is synchronous — no price data is included. Use {@link getAssets}
   * for the async version with fiat pricing.
   *
   * @param coinId - Optional coin ID to filter by (e.g. hex string). When omitted, all coin types are returned.
   * @returns Array of balance summaries (synchronous — no await needed).
   */
  getBalance(coinId?: string): Asset[] {
    return this.aggregateTokens(coinId);
  }

  /**
   * Get aggregated assets (tokens grouped by coinId) with price data.
   * Confirmed + unconfirmed tokens make up the spendable balance; in-flight
   * (`'transferring'`) tokens are reported only in the `transferring*` fields
   * and excluded from `totalAmount` (#517 item 3). Fiat value derives from
   * `totalAmount`, so it likewise excludes in-flight value.
   */
  async getAssets(coinId?: string): Promise<Asset[]> {
    const rawAssets = this.aggregateTokens(coinId);

    // Fetch prices if provider is available
    if (!this.host.priceProvider || this.host.isPriceDisabled() || rawAssets.length === 0) {
      return rawAssets;
    }

    try {
      const registry = TokenRegistry.getInstance();
      const nameToCoins = new Map<string, string[]>(); // tokenName -> coinIds[]

      for (const asset of rawAssets) {
        const def = registry.getDefinition(asset.coinId);
        if (def?.name) {
          const existing = nameToCoins.get(def.name);
          if (existing) {
            existing.push(asset.coinId);
          } else {
            nameToCoins.set(def.name, [asset.coinId]);
          }
        }
      }

      if (nameToCoins.size > 0) {
        const tokenNames = Array.from(nameToCoins.keys());
        const prices = await this.host.priceProvider.getPrices(tokenNames);

        return rawAssets.map((raw) => {
          const def = registry.getDefinition(raw.coinId);
          const price = def?.name ? prices.get(def.name) : undefined;
          let fiatValueUsd: number | null = null;
          let fiatValueEur: number | null = null;

          if (price) {
            const humanAmount = Number(raw.totalAmount) / Math.pow(10, raw.decimals);
            fiatValueUsd = humanAmount * price.priceUsd;
            if (price.priceEur != null) {
              fiatValueEur = humanAmount * price.priceEur;
            }
          }

          return {
            ...raw,
            priceUsd: price?.priceUsd ?? null,
            priceEur: price?.priceEur ?? null,
            change24h: price?.change24h ?? null,
            fiatValueUsd,
            fiatValueEur,
          };
        });
      }
    } catch (error) {
      logger.warn('Payments', 'Failed to fetch prices, returning assets without price data:', error);
    }

    return rawAssets;
  }

  /**
   * Aggregate tokens by coinId with confirmed/unconfirmed/transferring breakdown.
   * Excludes tokens with status 'spent' or 'invalid'.
   *
   * In-flight (`'transferring'`) tokens are LEAVING the wallet during an active
   * send, so they are NOT counted as spendable: they are tracked in their own
   * `transferring*` fields and excluded from `totalAmount`/`unconfirmedAmount`.
   * Counting them as balance would show the user value they cannot spend (the
   * #517 incident follow-up).
   */
  private aggregateTokens(coinId?: string): Asset[] {
    const assetsMap = new Map<string, AssetAccumulator>();

    for (const token of this.host.getHeldTokens().values()) {
      // Skip spent and invalid tokens; transferring tokens are tracked separately.
      if (token.status === 'spent' || token.status === 'invalid') continue;
      // #625: a suspected-spent source is excluded from spend selection, so it must not inflate the
      // DISPLAYED spendable balance either (else the wallet shows a total it cannot actually send).
      if (token.suspectedSpent) continue;
      if (coinId && token.coinId !== coinId) continue;
      this.accumulateToken(assetsMap, token);
    }

    return Array.from(assetsMap.values()).map((raw) => ({
      coinId: raw.coinId,
      symbol: raw.symbol,
      name: raw.name,
      decimals: raw.decimals,
      iconUrl: raw.iconUrl,
      // Spendable + soon-spendable holdings ONLY — the in-flight token is omitted.
      totalAmount: (raw.confirmedAmount + raw.unconfirmedAmount).toString(),
      tokenCount: raw.confirmedTokenCount + raw.unconfirmedTokenCount,
      confirmedAmount: raw.confirmedAmount.toString(),
      unconfirmedAmount: raw.unconfirmedAmount.toString(),
      confirmedTokenCount: raw.confirmedTokenCount,
      unconfirmedTokenCount: raw.unconfirmedTokenCount,
      transferringTokenCount: raw.transferringTokenCount,
      transferringAmount: raw.transferringAmount.toString(),
      priceUsd: null,
      priceEur: null,
      change24h: null,
      fiatValueUsd: null,
      fiatValueEur: null,
    }));
  }

  /** Fold one token into its coin's running totals (see {@link aggregateTokens}). */
  private accumulateToken(assetsMap: Map<string, AssetAccumulator>, token: Token): void {
    const acc = assetsMap.get(token.coinId) ?? this.newAssetAccumulator(token);
    assetsMap.set(token.coinId, acc);
    const amount = BigInt(token.amount);
    if (token.status === 'transferring') {
      acc.transferringAmount += amount;
      acc.transferringTokenCount++;
    } else if (token.status === 'confirmed') {
      acc.confirmedAmount += amount;
      acc.confirmedTokenCount++;
    } else {
      acc.unconfirmedAmount += amount;
      acc.unconfirmedTokenCount++;
    }
  }

  private newAssetAccumulator(token: Token): AssetAccumulator {
    return {
      coinId: token.coinId,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      iconUrl: token.iconUrl,
      confirmedAmount: 0n,
      unconfirmedAmount: 0n,
      transferringAmount: 0n,
      confirmedTokenCount: 0,
      unconfirmedTokenCount: 0,
      transferringTokenCount: 0,
    };
  }

  /**
   * Get all tokens, optionally filtered by coin type and/or status.
   *
   * @param filter - Optional filter criteria.
   * @param filter.coinId - Return only tokens of this coin type.
   * @param filter.status - Return only tokens with this status (e.g. `'submitted'` for unconfirmed).
   * @returns Array of matching {@link Token} objects (synchronous).
   */
  getTokens(filter?: { coinId?: string; status?: TokenStatus }): Token[] {
    let tokens = Array.from(this.host.getHeldTokens().values());

    if (filter?.coinId) {
      tokens = tokens.filter((t) => t.coinId === filter.coinId);
    }
    if (filter?.status) {
      tokens = tokens.filter((t) => t.status === filter.status);
    }

    return tokens;
  }

  /**
   * Get a single token by its local ID.
   *
   * @param id - The local UUID assigned when the token was added.
   * @returns The token, or `undefined` if not found.
   */
  getToken(id: string): Token | undefined {
    const token = this.host.getHeldTokens().get(id);
    if (!token) {
      logger.debug('Payments', `getToken: not found id=${id.slice(0, 16)}... mapSize=${this.host.getHeldTokens().size}`);
    }
    return token;
  }

  // ===========================================================================
  // Tombstones
  // ===========================================================================

  /**
   * Get all tombstone entries.
   *
   * Each tombstone is keyed by `(tokenId, stateHash)` and prevents a spent
   * token state from being re-added (e.g. via Nostr re-delivery).
   *
   * @returns A shallow copy of the tombstone array.
   */
  getTombstones(): TombstoneEntry[] {
    return [...this.tombstones];
  }

  /**
   * The LIVE tombstone array — for the module's storage-data builder, which
   * hands it straight to the TXF serializer (it read the field directly before
   * the split). Every other reader takes the copy from {@link getTombstones}.
   */
  get tombstoneList(): TombstoneEntry[] {
    return this.tombstones;
  }

  /** Replace the list wholesale on a storage load and rebuild the O(1) key set. */
  setTombstones(tombstones: TombstoneEntry[]): void {
    this.tombstones = tombstones;
    this.rebuildTombstoneKeySet();
  }

  /**
   * Record the tombstone for a SPENT state (never a reactivated newer state) —
   * called by the module's `removeToken`, the single spend path. `tokenId` is
   * the local map id, used only for the diagnostic when the keys are missing.
   */
  tombstoneSpentState(tokenId: string, genesisId: string | null, spentHash: string): void {
    if (genesisId && spentHash) {
      const key = `${genesisId}:${spentHash}`;
      if (!this.tombstoneKeySet.has(key)) {
        this.tombstones.push({ tokenId: genesisId, stateHash: spentHash, timestamp: Date.now() });
        this.tombstoneKeySet.add(key);
        logger.debug('Payments', `Created tombstone for ${genesisId.slice(0, 8)}..._${spentHash.slice(0, 8)}...`);
      }
    } else {
      logger.debug('Payments', `Warning: Could not create tombstone for token ${tokenId.slice(0, 8)}... (missing tokenId or stateHash)`);
    }
  }

  /**
   * Check whether a specific `(tokenId, stateHash)` combination is tombstoned.
   * Uses O(1) Set lookup instead of O(n) linear scan.
   *
   * @param tokenId - The genesis token ID.
   * @param stateHash - The state hash of the token version to check.
   * @returns `true` if the exact combination has been tombstoned.
   */
  isStateTombstoned(tokenId: string, stateHash: string): boolean {
    return this.tombstoneKeySet.has(`${tokenId}:${stateHash}`);
  }

  private rebuildTombstoneKeySet(): void {
    this.tombstoneKeySet.clear();
    for (const t of this.tombstones) {
      this.tombstoneKeySet.add(`${t.tokenId}:${t.stateHash}`);
    }
  }

  /**
   * Remove tombstones older than `maxAge` and cap the list at 100 entries.
   *
   * @param maxAge - Maximum age in milliseconds (default: 30 days).
   */
  async pruneTombstones(maxAge?: number): Promise<void> {
    const originalCount = this.tombstones.length;
    this.tombstones = pruneTombstonesByAge(this.tombstones, maxAge);
    this.rebuildTombstoneKeySet();

    if (this.tombstones.length < originalCount) {
      await this.host.save();
      logger.debug('Payments', `Pruned tombstones from ${originalCount} to ${this.tombstones.length}`);
    }
  }

  // ===========================================================================
  // Validation
  // ===========================================================================

  /**
   * Validate all tokens against the aggregator (oracle provider).
   *
   * Tokens that fail validation or are detected as spent are marked `'invalid'`.
   *
   * @returns Object with arrays of valid and invalid tokens.
   */
  async validate(): Promise<{ valid: Token[]; invalid: Token[] }> {
    this.host.ensureInitialized();

    const valid: Token[] = [];
    const invalid: Token[] = [];

    const engine = this.host.deps?.tokenEngine;
    for (const token of this.host.getHeldTokens().values()) {
      // v2-only: tokens are verified via the engine (local proof check + on-chain
      // spent-status). Anything that is not an engine blob is a stored v1 TXF
      // relic — unspendable since the cutover and no longer inspected here, so it
      // is left untouched rather than judged by a validator that cannot read it.
      if (!engine || !token.sdkData || !looksLikeTokenBlob(token.sdkData)) continue;

      try {
        const sphereToken = await engine.decodeToken(decodeTokenBlob(hexToBytes(token.sdkData)));
        const verdict = await engine.verify(sphereToken);
        const spent = verdict.ok ? await engine.isSpent(sphereToken) : false;
        if (verdict.ok && !spent) {
          valid.push(token);
        } else {
          token.status = 'invalid';
          this.host.deleteParsedToken(token.id);
          invalid.push(token);
        }
      } catch (err) {
        // Transient failure (decode/network) — do NOT invalidate funds on an
        // outage; skip this token for this run.
        logger.warn('Payments', `validate: engine check failed for ${token.id}, skipping:`, err);
      }
    }

    if (invalid.length > 0) {
      await this.host.save();
    }

    return { valid, invalid };
  }
}
