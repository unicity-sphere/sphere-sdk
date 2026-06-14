/**
 * Payments Module
 * Platform-independent token operations with full wallet repository functionality
 *
 * Includes:
 * - Token CRUD operations
 * - Tombstones for sync
 * - Archived tokens (spent history)
 * - Forked tokens (alternative histories)
 * - Transaction history
 * - Nametag storage
 */

import type {
  Asset,
  Token,
  TokenStatus,
  TransferRequest,
  TransferResult,
  IncomingTransfer,
  FullIdentity,
  SphereEventType,
  SphereEventMap,
} from '../../types';
import type {
  TxfToken,
  TxfTransaction,
  TombstoneEntry,
  NametagData,
} from '../../types/txf';
import { L1PaymentsModule, type L1PaymentsModuleConfig } from './L1PaymentsModule';
import type { SplitPlan, TokenWithAmount } from './TokenSplitCalculator';
import type { ITokenEngine, SphereToken } from '../../token-engine';
import { isV2TransferPayload, type V2TransferPayload } from '../../types/v2-transfer';
import { TokenReservationLedger } from './TokenReservationLedger';
import { SpendPlanner, SpendQueue, type ParsedTokenEntry, type ParsedTokenPool } from './SpendQueue';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../storage';
import type {
  TransportProvider,
  PeerInfo,
  IncomingTokenTransfer,
  PaymentRequestPayload,
  PaymentRequestResponsePayload,
  IncomingPaymentRequest as TransportPaymentRequest,
  IncomingPaymentRequestResponse as TransportPaymentRequestResponse,
} from '../../transport';
import type { TokenDeliveryTransport, TokenEnvelope } from '../../transport/courier/types';
import type { OracleProvider } from '../../oracle';
import type { PriceProvider } from '../../price';
import type {
  PaymentRequest,
  IncomingPaymentRequest,
  OutgoingPaymentRequest,
  PaymentRequestResult,
  PaymentRequestStatus,
  PaymentRequestHandler,
  PaymentRequestResponse,
  PaymentRequestResponseHandler,
} from '../../types';
import { STORAGE_KEYS_ADDRESS } from '../../constants';
import {
  tokenToTxf,
  getCurrentStateHash,
  buildTxfStorageData,
  parseTxfStorageData,
} from '../../serialization/txf-serializer';
import { TokenRegistry } from '../../registry';
import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';
import { sha256, bytesToHex, hexToBytes } from '../../core/crypto';
import { decodeTokenBlob, encodeTokenBlob } from '../../token-engine/token-blob';
import { deriveDirectAddress } from '../../token-engine/identity';
import { parseInvoiceMemoForOnChain } from '../accounting/memo.js';

// =============================================================================
// Transaction History Entry
// =============================================================================

/**
 * Public history entry type — re-exported from the shared storage layer.
 * Single source of truth: {@link HistoryRecord} in `storage/storage-provider.ts`.
 */
export type TransactionHistoryEntry = import('../../storage').HistoryRecord;

/**
 * Compute a dedup key for a history entry.
 * - SENT + transferId → groups multi-token sends into a single entry
 * - type + tokenId → one entry per token per direction
 * - fallback → UUID (no dedup possible)
 */
function computeHistoryDedupKey(type: string, tokenId?: string, transferId?: string): string {
  if (type === 'SENT' && transferId) return `${type}_transfer_${transferId}`;
  if (tokenId) return `${type}_${tokenId}`;
  return `${type}_${crypto.randomUUID()}`;
}

/** Maximum number of history entries to include in IPFS-synced TXF data */
const MAX_SYNCED_HISTORY_ENTRIES = 5000;

/**
 * Overall timeout for a single engine transfer/split during send(). Overrides
 * the SDK's 10s default inclusion-proof abort — a slow aggregator must get a
 * fair window, because once the certification is submitted the source state is
 * spent on-chain and an early abort strands the finished token.
 */
const SEND_ENGINE_OP_TIMEOUT_MS = 60_000;

/**
 * A FINISHED v2 token blob awaiting transport delivery. Journaled the moment
 * the transfer/split output is certified on-chain (the source is already
 * spent) and removed after successful delivery, so a transport failure or a
 * crash never loses the recipient's token. Replayed by load().
 */
interface PendingV2Delivery {
  transferId: string;
  recipientPubkey: string;
  /** Hex of the finished token blob (the V2_TRANSFER payload). */
  tokenBlob: string;
  memo?: string;
  createdAt: number;
  /**
   * The channel this blob was delivered over. `'courier'` entries are GC'd ONLY on a
   * valid-ackSig `onDelivered(entryId)` and re-deposited (not Nostr-sent) on replay;
   * `'nostr'` / undefined (legacy) entries are removed right after a successful send
   * and replayed over Nostr — preserving today's behavior.
   */
  transport?: 'courier' | 'nostr';
  /**
   * The courier entryId for this delivery (present only on `transport: 'courier'`).
   * `onDelivered(entryId)` resolves the blob to GC via this mapping.
   */
  entryId?: string;
  /** Recipient compressed chain pubkey — the courier address (courier entries only). */
  recipientChainPubkey?: string;
}

// =============================================================================
// Receive Options & Result
// =============================================================================

/**
 * @deprecated v2 transfers arrive as finished tokens — there is no finalization
 * phase. The options are accepted for backwards compatibility and ignored.
 */
export interface ReceiveOptions {
  /** @deprecated Ignored — v2 tokens are stored confirmed on receipt. */
  finalize?: boolean;
  /** @deprecated Ignored. */
  timeout?: number;
  /** @deprecated Ignored. */
  pollInterval?: number;
}

export interface ReceiveResult {
  /** Newly received incoming transfers. */
  transfers: IncomingTransfer[];
}

// =============================================================================
// Token Parsing Utilities
// =============================================================================

interface ParsedTokenInfo {
  coinId: string;
  symbol: string;
  name: string;
  decimals: number;
  iconUrl?: string;
  amount: string;
  tokenId?: string;
}

/**
 * Enrich token info with data from TokenRegistry
 */
function enrichWithRegistry(info: ParsedTokenInfo): ParsedTokenInfo {
  const registry = TokenRegistry.getInstance();
  const def = registry.getDefinition(info.coinId);
  if (def) {
    return {
      ...info,
      symbol: def.symbol || info.symbol,
      name: def.name.charAt(0).toUpperCase() + def.name.slice(1),
      decimals: def.decimals ?? 0,
      iconUrl: registry.getIconUrl(info.coinId) ?? undefined,
    };
  }
  return info;
}

/**
 * Parse token info from SDK token data or TXF JSON
 */
export async function parseTokenInfo(tokenData: unknown, engine?: ITokenEngine): Promise<ParsedTokenInfo> {
  const defaultInfo: ParsedTokenInfo = {
    coinId: 'ALPHA',
    symbol: 'ALPHA',
    name: 'Alpha Token',
    decimals: 0,
    amount: '0',
  };

  // v2 engine path: tokenData is the engine blob (hex of CBOR(TokenBlob)). The
  // value (coins) requires decoding the payment envelope, so it goes through the
  // engine; the genesis-stable tokenId comes from engine.tokenId.
  if (engine && typeof tokenData === 'string' && looksLikeTokenBlob(tokenData)) {
    try {
      const token = await engine.decodeToken(decodeTokenBlob(hexToBytes(tokenData)));
      const first = engine.readValue(token)?.assets[0];
      if (first) {
        return enrichWithRegistry({
          coinId: first.coinId,
          symbol: first.coinId.slice(0, 8),
          name: `Token ${first.coinId.slice(0, 8)}`,
          decimals: 0,
          amount: String(first.amount),
          tokenId: engine.tokenId(token),
        });
      }
      // Value-less (data) token: keep defaults but carry the genesis tokenId.
      return { ...defaultInfo, tokenId: engine.tokenId(token) };
    } catch (error) {
      logger.warn('Payments', 'Failed to parse token info via engine:', error);
      // fall through to legacy parsing
    }
  }

  try {
    // If it's a string, try to parse as JSON
    const data = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;

    // Manual extraction from legacy v1 TXF JSON (display-only — the v1 engine is
    // gone, so stored TXF tokens are parsed as plain JSON, never via an SDK).
    if (data.genesis?.data) {
      const genesis = data.genesis.data;
      if (genesis.coinData) {
        // coinData can be: [[coinIdHex, amount]] or {coinIdHex: amount}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const coinData = genesis.coinData as any;
        if (Array.isArray(coinData) && coinData.length > 0) {
          const firstEntry = coinData[0];
          if (Array.isArray(firstEntry) && firstEntry.length === 2) {
            const [coinIdHex, amount] = firstEntry;
            return enrichWithRegistry({
              coinId: String(coinIdHex),
              symbol: String(coinIdHex).slice(0, 8),
              name: `Token ${String(coinIdHex).slice(0, 8)}`,
              decimals: 0,
              amount: String(amount),
              tokenId: genesis.tokenId,
            });
          }
        } else if (typeof coinData === 'object') {
          const coinEntries = Object.entries(coinData);
          if (coinEntries.length > 0) {
            const [coinId, amount] = coinEntries[0] as [string, unknown];
            return enrichWithRegistry({
              coinId,
              symbol: coinId.slice(0, 8),
              name: `Token ${coinId.slice(0, 8)}`,
              decimals: 0,
              amount: String(amount),
              tokenId: genesis.tokenId,
            });
          }
        }
      }
      if (genesis.tokenId) {
        defaultInfo.tokenId = genesis.tokenId;
      }
    }

    // Try to extract from state if available
    if (data.state?.coinData) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const coinData = data.state.coinData as any;
      if (Array.isArray(coinData) && coinData.length > 0) {
        const firstEntry = coinData[0];
        if (Array.isArray(firstEntry) && firstEntry.length === 2) {
          const [coinIdHex, amount] = firstEntry;
          return enrichWithRegistry({
            coinId: String(coinIdHex),
            symbol: String(coinIdHex).slice(0, 8),
            name: `Token ${String(coinIdHex).slice(0, 8)}`,
            decimals: 0,
            amount: String(amount),
            tokenId: defaultInfo.tokenId,
          });
        }
      } else if (typeof coinData === 'object') {
        const coinEntries = Object.entries(coinData);
        if (coinEntries.length > 0) {
          const [coinId, amount] = coinEntries[0] as [string, unknown];
          return enrichWithRegistry({
            coinId,
            symbol: coinId.slice(0, 8),
            name: `Token ${coinId.slice(0, 8)}`,
            decimals: 0,
            amount: String(amount),
            tokenId: defaultInfo.tokenId,
          });
        }
      }
    }
  } catch (error) {
    logger.warn('Payments', 'Failed to parse token info:', error);
  }

  return defaultInfo;
}

// =============================================================================
// Repository Utility Functions
// =============================================================================

// Cache parsed sdkData fields to avoid repeated JSON.parse in hot loops.
// Key = sdkData string reference, value = { tokenId, stateHash }.
// Cleared on address switch via clearSdkDataCache().
const sdkDataCache = new Map<string, { tokenId: string | null; stateHash: string }>();
const SDK_DATA_CACHE_MAX = 2000;

/** A v2 engine blob is hex (CBOR); legacy v1 TXF is JSON (starts with '{'). */
function looksLikeTokenBlob(sdkData: string): boolean {
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
    // Legacy v1 TXF JSON.
    let tokenId: string | null = null;
    let stateHash = '';
    try {
      const txf = JSON.parse(sdkData);
      tokenId = txf.genesis?.data?.tokenId || null;
      stateHash = getCurrentStateHash(txf as TxfToken) || '';

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
 * Convert hex string to Uint8Array
 */
function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Check if two tokens have the same genesis tokenId (same token, possibly different states)
 */
function hasSameGenesisTokenId(t1: Token, t2: Token): boolean {
  const id1 = extractTokenIdFromSdkData(t1.sdkData);
  const id2 = extractTokenIdFromSdkData(t2.sdkData);
  return !!(id1 && id2 && id1 === id2);
}

/**
 * Check if two tokens are exactly the same (same tokenId AND same stateHash)
 */
function isSameTokenState(t1: Token, t2: Token): boolean {
  const key1 = extractTokenStateKey(t1);
  const key2 = extractTokenStateKey(t2);
  return !!(key1 && key2 && key1 === key2);
}

/**
 * Create tombstone from token - requires valid tokenId and stateHash
 */
function createTombstoneFromToken(token: Token): TombstoneEntry | null {
  const tokenId = extractTokenIdFromSdkData(token.sdkData);
  const stateHash = extractStateHashFromSdkData(token.sdkData);

  // Both tokenId and stateHash are required for a valid tombstone
  if (!tokenId || !stateHash) {
    return null;
  }

  return {
    tokenId,
    stateHash,
    timestamp: Date.now(),
  };
}

/**
 * Check if incoming token is an incremental update
 */
function isIncrementalUpdate(existing: TxfToken, incoming: TxfToken): boolean {
  if (existing.genesis?.data?.tokenId !== incoming.genesis?.data?.tokenId) {
    return false;
  }

  const existingTxns = existing.transactions || [];
  const incomingTxns = incoming.transactions || [];

  if (incomingTxns.length < existingTxns.length) {
    return false;
  }

  for (let i = 0; i < existingTxns.length; i++) {
    const existingTx = existingTxns[i];
    const incomingTx = incomingTxns[i];

    if (existingTx.previousStateHash !== incomingTx.previousStateHash ||
        existingTx.newStateHash !== incomingTx.newStateHash) {
      return false;
    }
  }

  for (let i = existingTxns.length; i < incomingTxns.length; i++) {
    const newTx = incomingTxns[i] as TxfTransaction;
    if (newTx.inclusionProof === null) {
      return false;
    }
  }

  return true;
}

/**
 * Count committed transactions
 */
function countCommittedTxns(txf: TxfToken): number {
  return (txf.transactions || []).filter(
    (tx: TxfTransaction) => tx.inclusionProof !== null
  ).length;
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

/**
 * Prune Map by count
 */
function pruneMapByCount<T>(items: Map<string, T>, maxCount: number): Map<string, T> {
  if (items.size <= maxCount) {
    return new Map(items);
  }

  const entries = [...items.entries()];
  const toKeep = entries.slice(entries.length - maxCount);
  return new Map(toKeep);
}

/**
 * Find best token version from archives
 */
function findBestTokenVersion(
  tokenId: string,
  archivedTokens: Map<string, TxfToken>,
  forkedTokens: Map<string, TxfToken>
): TxfToken | null {
  const candidates: TxfToken[] = [];

  const archived = archivedTokens.get(tokenId);
  if (archived) candidates.push(archived);

  for (const [key, forked] of forkedTokens) {
    if (key.startsWith(tokenId + '_')) {
      candidates.push(forked);
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => countCommittedTxns(b) - countCommittedTxns(a));
  return candidates[0];
}

// =============================================================================
// Configuration
// =============================================================================

export interface PaymentsModuleConfig {
  /** Auto-sync after operations */
  autoSync?: boolean;
  /** Auto-validate with aggregator */
  autoValidate?: boolean;
  /** Retry failed transfers */
  retryFailed?: boolean;
  /** Max retry attempts */
  maxRetries?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** L1 (ALPHA blockchain) configuration. Set to null to explicitly disable L1. */
  l1?: L1PaymentsModuleConfig | null;
}

// =============================================================================
// NOSTR-FIRST Proof Polling Types
// =============================================================================

/**
 * Job for background proof polling (NOSTR-FIRST pattern)
 */
export interface ProofPollingJob {
  tokenId: string;
  requestIdHex: string;
  commitmentJson: string;
  startedAt: number;
  attemptCount: number;
  lastAttemptAt: number;
  /** Callback when proof is received */
  onProofReceived?: (tokenId: string) => void;
}

// =============================================================================
// Dependencies Interface
// =============================================================================

export interface PaymentsModuleDependencies {
  identity: FullIdentity;
  storage: StorageProvider;
  /** @deprecated Use tokenStorageProviders instead */
  tokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
  /** Multiple token storage providers (e.g., IPFS, MongoDB, file) */
  tokenStorageProviders?: Map<string, TokenStorageProvider<TxfStorageDataBase>>;
  transport: TransportProvider;
  /**
   * Optional v2 token-delivery transport (the courier). ADDITIVE + flag-gated: when
   * present, finished v2 token blobs are DEPOSITED over this channel (courier-primary,
   * with a Nostr fallback on deposit failure); when absent, delivery is Nostr-only —
   * byte-identical to today. Resolution stays on Nostr (`transport.resolve`); the
   * courier only consumes the already-resolved recipient chainPubkey. Its sinks
   * (incoming feed + delivery-confirmed GC) are bound to this module in `initialize()`.
   */
  deliveryTransport?: TokenDeliveryTransport;
  oracle: OracleProvider;
  /**
   * Token engine (v2). Optional during migration (path B): when provided, value
   * reads / lifecycle go through the engine; otherwise the legacy v1 SDK path is
   * used. Wired by Sphere once the engine is constructed (A4-int).
   */
  tokenEngine?: ITokenEngine;
  emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
  /** Chain code for BIP32 HD derivation (for L1 multi-address support) */
  chainCode?: string;
  /** Additional L1 addresses to watch */
  l1Addresses?: string[];
  /** Price provider (optional — enables fiat value display) */
  price?: PriceProvider;
  /** Set of disabled provider IDs — disabled providers are skipped during sync/save */
  disabledProviderIds?: ReadonlySet<string>;
}

// =============================================================================
// Implementation
// =============================================================================

export class PaymentsModule {
  private readonly moduleConfig: Omit<Required<PaymentsModuleConfig>, 'l1'>;
  private deps: PaymentsModuleDependencies | null = null;

  /** L1 (ALPHA blockchain) payments sub-module (null if disabled) */
  readonly l1: L1PaymentsModule | null;

  // Token State
  private tokens: Map<string, Token> = new Map();
  private pendingTransfers: Map<string, TransferResult> = new Map();
  private pendingBackgroundTasks: Promise<void>[] = [];

  // Repository State (tombstones, archives, forked, history)
  private tombstones: TombstoneEntry[] = [];
  // O(1) lookup set derived from tombstones array. Rebuilt via rebuildTombstoneKeySet().
  private tombstoneKeySet: Set<string> = new Set();
  private archivedTokens: Map<string, TxfToken> = new Map();
  private forkedTokens: Map<string, TxfToken> = new Map();
  private _historyCache: TransactionHistoryEntry[] = [];
  private nametags: NametagData[] = [];

  // Payment Requests State (Incoming)
  private paymentRequests: IncomingPaymentRequest[] = [];
  private paymentRequestHandlers: Set<PaymentRequestHandler> = new Set();

  // Payment Requests State (Outgoing)
  private outgoingPaymentRequests: Map<string, OutgoingPaymentRequest> = new Map();
  private paymentRequestResponseHandlers: Set<PaymentRequestResponseHandler> = new Set();
  private pendingResponseResolvers: Map<string, {
    resolve: (response: PaymentRequestResponse) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }> = new Map();

  // Subscriptions
  private unsubscribeTransfers: (() => void) | null = null;
  private unsubscribePaymentRequests: (() => void) | null = null;
  private unsubscribePaymentRequestResponses: (() => void) | null = null;

  // Guard: ensure load() completes before processing incoming bundles
  private loadedPromise: Promise<void> | null = null;
  private loaded = false;

  // Storage event subscriptions (push-based sync)
  private storageEventUnsubscribers: (() => void)[] = [];
  private syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SYNC_DEBOUNCE_MS = 500;

  /** Sync coalescing: concurrent sync() calls share the same operation */
  private _syncInProgress: Promise<{ added: number; removed: number }> | null = null;

  /** Token change observers — notified when a token is added, updated, or removed */
  private tokenChangeCallbacks: Array<(tokenId: string, sdkData: string) => void> = [];

  // Token Spend Queue — concurrent send race condition prevention
  private readonly reservationLedger = new TokenReservationLedger();
  private readonly spendPlanner = new SpendPlanner();
  private spendQueue: SpendQueue;
  /** Cache of parsed SdkToken data for synchronous queue re-evaluation */
  private readonly parsedTokenCache: Map<string, ParsedTokenEntry> = new Map();

  constructor(config?: PaymentsModuleConfig) {
    this.moduleConfig = {
      autoSync: config?.autoSync ?? true,
      autoValidate: config?.autoValidate ?? true,
      retryFailed: config?.retryFailed ?? true,
      maxRetries: config?.maxRetries ?? 3,
      debug: config?.debug ?? false,
    };

    // Initialize L1 sub-module by default (L1PaymentsModule has default electrumUrl).
    // Only skip if l1 is explicitly set to null. The module is lazy — it won't
    // open a WebSocket until the first L1 operation is performed.
    this.l1 = config?.l1 === null ? null : new L1PaymentsModule(config?.l1);

    // Initialize spend queue (requires ledger, planner, and access to this.tokens)
    this.spendQueue = new SpendQueue(
      this.reservationLedger,
      this.spendPlanner,
      () => this.tokens,
      this.parsedTokenCache
    );
  }

  /**
   * Get the current module configuration (excluding L1 config).
   *
   * @returns Resolved configuration with all defaults applied.
   */
  getConfig(): Omit<Required<PaymentsModuleConfig>, 'l1'> {
    return this.moduleConfig;
  }

  /**
   * Register a callback to be notified when a token is added or updated.
   *
   * The callback receives the token's genesis `tokenId` (64-hex) and the raw
   * `sdkData` JSON string. This enables consumers (e.g., AccountingModule) to
   * index token transactions at mutation time rather than doing periodic scans.
   *
   * @param cb - Callback: `(tokenId: string, sdkData: string) => void`
   * @returns Unsubscribe function.
   */
  onTokenChange(cb: (tokenId: string, sdkData: string) => void): () => void {
    this.tokenChangeCallbacks.push(cb);
    return () => {
      this.tokenChangeCallbacks = this.tokenChangeCallbacks.filter((c) => c !== cb);
    };
  }

  /**
   * Notify all registered token change observers.
   * Called from addToken(), updateToken() after successful mutation.
   * Errors in callbacks are silently caught to prevent disrupting the caller.
   */
  private notifyTokenChange(token: Token): void {
    if (this.tokenChangeCallbacks.length === 0) return;
    const tokenId = extractTokenIdFromSdkData(token.sdkData);
    if (!tokenId || !token.sdkData) return;
    for (const cb of this.tokenChangeCallbacks) {
      try {
        cb(tokenId, token.sdkData);
      } catch {
        // Silently ignore callback errors
      }
    }
  }

  /** Price provider (optional) */
  private priceProvider: PriceProvider | null = null;

  // ===========================================================================
  // Lifecycle
  // ===========================================================================

  /**
   * Initialize module with dependencies
   */
  initialize(deps: PaymentsModuleDependencies): void {
    // Clean up previous subscriptions before re-initializing
    this.unsubscribeTransfers?.();
    this.unsubscribeTransfers = null;
    this.unsubscribePaymentRequests?.();
    this.unsubscribePaymentRequests = null;
    this.unsubscribePaymentRequestResponses?.();
    this.unsubscribePaymentRequestResponses = null;

    // Stop background subscriptions from the previous address context so they
    // don't call save() in the new address's storage context.
    this.unsubscribeStorageEvents();

    // Cancel pending payment response resolvers
    for (const [, resolver] of this.pendingResponseResolvers) {
      clearTimeout(resolver.timeout);
      resolver.reject(new Error('Address switched'));
    }
    this.pendingResponseResolvers.clear();

    // Reset per-address state (will be re-populated by load())
    this.tokens.clear();
    clearSdkDataCache();
    this.pendingTransfers.clear();
    this.tombstones = [];
    this.tombstoneKeySet.clear();
    this.archivedTokens.clear();
    this.forkedTokens.clear();
    this._historyCache = [];
    this.nametags = [];

    // Reset spend queue state
    this.reservationLedger.clear();
    this.parsedTokenCache.clear();
    this.spendQueue.destroy();
    this.spendQueue = new SpendQueue(
      this.reservationLedger,
      this.spendPlanner,
      () => this.tokens,
      this.parsedTokenCache
    );

    this.deps = deps;
    this.priceProvider = deps.price ?? null;
    // Path B: wire the engine into the planner (value reads use it when present).
    this.spendPlanner.setEngine(deps.tokenEngine);

    // Initialize L1 sub-module with chain code, addresses, and transport (if enabled)
    if (this.l1) {
      this.l1.initialize({
        identity: deps.identity,
        chainCode: deps.chainCode,
        addresses: deps.l1Addresses,
        transport: deps.transport,
      });
    }

    // Subscribe to incoming transfers
    this.unsubscribeTransfers = deps.transport.onTokenTransfer((transfer) =>
      this.handleIncomingTransfer(transfer)
    );

    // Bind the courier (TokenDeliveryTransport) sinks to THIS module, so a
    // courier-received transfer flows through the SAME handleV2Transfer path (dedup +
    // verify + isOwnedBy) and a confirmed delivery GCs PENDING_V2_DELIVERIES. The
    // courier is ADDITIVE — when absent, nothing here runs (Nostr-only, default OFF).
    deps.deliveryTransport?.setSinks?.({
      onV2Transfer: (payload, senderPubkey) => this.handleV2Transfer(payload, senderPubkey),
      onDelivered: (entryId) => this.removePendingV2DeliveryByEntryId(entryId),
    });

    // Subscribe to incoming payment requests (if supported)
    if (deps.transport.onPaymentRequest) {
      this.unsubscribePaymentRequests = deps.transport.onPaymentRequest((request) => {
        this.handleIncomingPaymentRequest(request);
      });
    }

    // Subscribe to payment request responses (if supported)
    if (deps.transport.onPaymentRequestResponse) {
      this.unsubscribePaymentRequestResponses = deps.transport.onPaymentRequestResponse((response) => {
        this.handlePaymentRequestResponse(response);
      });
    }

    // Subscribe to storage provider events (push-based sync)
    this.subscribeToStorageEvents();
  }

  /**
   * Load all token data from storage providers and restore wallet state.
   *
   * Loads tokens, nametag data, transaction history, and pending transfers
   * from configured storage providers. Restores pending V5 tokens and
   * triggers a fire-and-forget {@link resolveUnconfirmed} call.
   */
  async load(): Promise<void> {
    this.ensureInitialized();

    // Expose a promise that incoming transfer handlers can await to ensure
    // the token map is populated before running dedup checks.
    const doLoad = async () => {
      // Ensure token registry has loaded metadata (symbol, name, decimals)
      // before parsing tokens — otherwise tokens get fallback truncated coinId values
      await TokenRegistry.waitForReady();

      // Load metadata from TokenStorageProviders (archived, tombstones, forked)
      // Active tokens are NOT stored in TXF - they are loaded from token-xxx files
      const providers = this.getTokenStorageProviders();
      // Precompute this wallet's acceptable `_meta.address` set once (includes the
      // vault's XP-invariant DIRECT address) so a vault restore is not rejected.
      const ownAddresses = await this.ownMetaAddresses();
      for (const [id, provider] of providers) {
        try {
          const result = await provider.load();
          if (result.success && result.data) {
            // Address guard: reject data from a DIFFERENT address. The stored
            // `_meta.address` may be the L1 address (local TXF stores), the chain
            // pubkey, the runtime DIRECT:// predicate address, OR the vault's
            // XP-invariant DIRECT:// reserved slot — accept any of OUR own.
            const loadedMeta = (result.data as TxfStorageDataBase)?._meta;
            if (!this.isOwnAddress(loadedMeta?.address, ownAddresses)) {
              logger.warn('Payments', `Load: rejecting data from provider ${id} — address mismatch (got=${loadedMeta!.address.slice(0, 20)}... expected one of this wallet's addresses)`);
              continue;
            }

            this.loadFromStorageData(result.data);
            // Rebuild parsedTokenCache for spend queue (loadFromStorageData bypasses addToken)
            await this.rebuildParsedTokenCache();
            // Import history from IPFS TXF data into local store
            const txfData = result.data as TxfStorageDataBase;
            if (txfData._history && txfData._history.length > 0) {
              await this.importRemoteHistoryEntries(txfData._history as HistoryRecord[]);
            }
            logger.debug('Payments', `Loaded metadata from provider ${id}`);
            break; // Use first successful provider
          }
        } catch (err) {
          logger.error('Payments', `Failed to load from provider ${id}:`, err);
        }
      }

      // Remove stale placeholder tokens from interrupted sends.
      // Placeholders have sdkData = '{"_placeholder":true}' — they were temporary
      // UI stand-ins for change tokens whose background minting never completed.
      for (const [id, token] of this.tokens) {
        try {
          if (token.sdkData) {
            const data = JSON.parse(token.sdkData);
            if (data?._placeholder) {
              this.tokens.delete(id);
              logger.debug('Payments', `Removed stale placeholder token: ${id}`);
            }
          }
        } catch {
          // Not valid JSON — not a placeholder
        }
      }

      // Log loaded tokens
      const loadedTokens = Array.from(this.tokens.values()).map(t => `${t.id.slice(0, 12)}(${t.status})`);
      logger.debug('Payments', `load(): from TXF providers: ${this.tokens.size} tokens [${loadedTokens.join(', ')}]`);

      // v1 cutover: orphaned pending-V5 tokens (saved by the removed instant-split
      // receiver) can never confirm — their finalization path was v1-only. Move
      // them to the terminal 'invalid' state instead of leaving phantom
      // 'submitted' balance forever. sdkData is kept intact for audit.
      // They lived in the legacy PENDING_V5_TOKENS KV key (TXF never persisted
      // them), so this is a one-time KV migration; the in-map sweep below covers
      // any stragglers that did land in token storage.
      let terminalized = 0;
      try {
        const legacyPendingV5 = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS);
        if (legacyPendingV5) {
          const v5Tokens = JSON.parse(legacyPendingV5) as Token[];
          for (const t of v5Tokens) {
            if (this.tokens.has(t.id)) continue;
            t.status = 'invalid';
            t.updatedAt = Date.now();
            this.tokens.set(t.id, t);
            terminalized++;
          }
          await this.deps!.storage.remove(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS);
        }
      } catch (err) {
        logger.warn('Payments', 'load(): failed to migrate legacy PENDING_V5_TOKENS:', err);
      }
      for (const [, t] of this.tokens) {
        if (t.status !== 'submitted') continue;
        const isPendingV5 = t.id.startsWith('v5split_')
          || (t.sdkData?.startsWith('{') && (() => {
            try { return '_pendingFinalization' in JSON.parse(t.sdkData!); } catch { return false; }
          })());
        if (isPendingV5) {
          t.status = 'invalid';
          t.updatedAt = Date.now();
          terminalized++;
        }
      }
      if (terminalized > 0) {
        logger.warn('Payments', `load(): terminalized ${terminalized} orphaned pending-V5 token(s) (v1 finalization removed)`);
        await this.save();
      }

      // Crash recovery: tokens persisted mid-send stay 'transferring' forever —
      // nothing else writes that status, and v2 storage round-trips it verbatim.
      // Reconcile against the network: spent on-chain → terminal 'spent';
      // unspent → back to 'confirmed' (spendable again). Engine/network
      // unavailable → leave for the next load. In-flight sends in THIS session
      // are protected by their reservation, so flipping is safe.
      const recoveryEngine = this.deps?.tokenEngine;
      if (recoveryEngine) {
        let reconciled = 0;
        for (const [, t] of this.tokens) {
          if (t.status !== 'transferring' || !t.sdkData || !looksLikeTokenBlob(t.sdkData)) continue;
          try {
            const st = await recoveryEngine.decodeToken(decodeTokenBlob(hexToBytes(t.sdkData)));
            const spent = await recoveryEngine.isSpent(st);
            t.status = spent ? 'spent' : 'confirmed';
            t.updatedAt = Date.now();
            if (!spent) await this.cacheEngineParsedToken(t);
            reconciled++;
          } catch {
            // Aggregator unreachable — keep 'transferring', retry next load.
          }
        }
        if (reconciled > 0) {
          logger.warn('Payments', `load(): reconciled ${reconciled} token(s) stuck in 'transferring' from an interrupted send`);
          await this.save();
        }
      }

      // Load transaction history from dedicated history store (with migration from legacy KV)
      await this.loadHistory();

      // Load pending transfers
      const pending = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.PENDING_TRANSFERS);
      if (pending) {
        const transfers = JSON.parse(pending) as TransferResult[];
        for (const transfer of transfers) {
          this.pendingTransfers.set(transfer.id, transfer);
        }
      }

      this.loaded = true;
    };

    this.loadedPromise = doLoad();
    await this.loadedPromise;

    // Replay finished-but-undelivered v2 blobs from a previous session
    // (fire-and-forget; failures are kept journaled for the next load).
    void this.replayPendingV2Deliveries().catch((err) =>
      logger.warn('Payments', 'Pending v2 delivery replay failed:', err));

    // Drive the courier's store-and-forward loops once per load (additive; a no-op
    // when no deliveryTransport is configured): pull the inbox, reconcile sender-side
    // delivery confirmations, and re-fire any crash-interrupted acks.
    this.runCourierLoops('load');
  }

  /**
   * Kick the courier's receive / poll / ack-replay loops fire-and-forget. Each is
   * optional on the {@link TokenDeliveryTransport}; a missing method (or a missing
   * transport entirely) is simply skipped, so the Nostr-only path is unaffected.
   */
  private runCourierLoops(context: 'load' | 'receive'): void {
    const courier = this.deps?.deliveryTransport;
    if (!courier) return;
    const warn = (op: string) => (err: unknown) =>
      logger.warn('Payments', `Courier ${op} (${context}) failed:`, err);
    void courier.receive?.().catch(warn('receive'));
    void courier.pollSent?.().catch(warn('pollSent'));
    void courier.replayAckPending?.().catch(warn('replayAckPending'));
  }

  /**
   * Cleanup all subscriptions, polling jobs, and pending resolvers.
   *
   * Should be called when the wallet is being shut down or the module is
   * no longer needed. Also destroys the L1 sub-module if present.
   */
  destroy(): void {
    this.unsubscribeTransfers?.();
    this.unsubscribeTransfers = null;
    this.unsubscribePaymentRequests?.();
    this.unsubscribePaymentRequests = null;
    this.unsubscribePaymentRequestResponses?.();
    this.unsubscribePaymentRequestResponses = null;
    this.paymentRequestHandlers.clear();
    this.paymentRequestResponseHandlers.clear();

    // Clear pending response resolvers
    for (const [, resolver] of this.pendingResponseResolvers) {
      clearTimeout(resolver.timeout);
      resolver.reject(new Error('Module destroyed'));
    }
    this.pendingResponseResolvers.clear();

    // Clean up spend queue and reservation ledger
    this.spendQueue.destroy();
    this.reservationLedger.clear();
    this.parsedTokenCache.clear();

    // Clean up storage event subscriptions
    this.unsubscribeStorageEvents();

    if (this.l1) {
      this.l1.destroy();
    }
  }

  // ===========================================================================
  // Public API - Send
  // ===========================================================================

  /**
   * Send tokens to recipient
   * Supports automatic token splitting when exact amount is needed
   *
   * @param request - Transfer request.
   * @param internal - Internal options (not part of the public API).
   *   `existingReservationId` and `existingSplitPlan` allow callers (e.g. instantSplitSend)
   *   to pass an already-acquired reservation, skipping the planSend() critical section.
   */
  async send(
    request: TransferRequest,
    internal?: { existingReservationId?: string; existingSplitPlan?: SplitPlan },
  ): Promise<TransferResult> {
    this.ensureInitialized();

    // Track this send() so switchToAddress() waits for it via waitForPendingOperations().
    // Without this, the user can switch addresses while send() is still running,
    // and save() calls inside send() would write to the wrong address's storage.
    let resolveSendTracker!: () => void;
    const sendTracker = new Promise<void>(r => { resolveSendTracker = r; });
    this.pendingBackgroundTasks.push(sendTracker);

    // Use mutable result for building the transfer
    const result: { -readonly [K in keyof TransferResult]: TransferResult[K] } = {
      id: internal?.existingReservationId ?? crypto.randomUUID(),
      status: 'pending',
      tokens: [],
      tokenTransfers: [],
    };

    // W23-R2 (v2): ids of source tokens whose spend was CERTIFIED on-chain during
    // this send. The failure handler must never restore these as 'confirmed' —
    // their state is consumed; the finished output blob is journaled separately.
    const committedOnChainTokenIds = new Set<string>();

    try {
      // Resolve recipient
      const peerInfo: PeerInfo | null = await this.deps!.transport.resolve?.(request.recipient) ?? null;
      const recipientPubkey = this.resolveTransportPubkey(request.recipient, peerInfo);

      // v2: the engine is the only send path — transfers go to the recipient's
      // chainPubkey (SignaturePredicate). Fail loudly when either is missing.
      if (!this.deps?.tokenEngine) {
        throw new SphereError(
          'Token engine unavailable — cannot send. The oracle must supply a v2 trust base + gateway URL (and API key where required).',
          'AGGREGATOR_ERROR'
        );
      }
      if (!peerInfo?.chainPubkey) {
        throw new SphereError(
          `Recipient ${request.recipient} has no published identity (chain pubkey) — cannot receive v2 transfers.`,
          'INVALID_RECIPIENT'
        );
      }

      let splitPlan: SplitPlan;

      if (internal?.existingSplitPlan) {
        // W23 fix: Reuse the reservation + plan from instantSplitSend to avoid
        // the cancel-then-reacquire race window.
        splitPlan = internal.existingSplitPlan;
      } else {
        // ── Coin symbol → coinId resolution ────────────────────────────────────
        // Swap manifests store currencies as short symbols (e.g. "ETH", "BTC")
        // while token storage uses 64/68-char hex coinIds. If no tokens match
        // the literal coinId, attempt to resolve via the token registry.
        const resolvedCoinId = (() => {
          const literalMatch = Array.from(this.tokens.values()).some(t => t.coinId === request.coinId);
          if (!literalMatch && request.coinId.length <= 20) {
            const def = TokenRegistry.getInstance().getDefinitionBySymbol(request.coinId);
            if (def?.id) return def.id;
          }
          return request.coinId;
        })();
        if (resolvedCoinId !== request.coinId) {
          request = { ...request, coinId: resolvedCoinId };
        }

        // ── Spend Queue: Pre-parse token pool (async, before critical section) ──
        const parsedPool = await this.spendPlanner.buildParsedPool(
          Array.from(this.tokens.values()),
          request.coinId
        );

        // ── Spend Queue: SYNCHRONOUS CRITICAL SECTION (no awaits) ──────────────
        // planSend reads free amounts, runs split calculation, and creates a
        // reservation atomically. No concurrent send() can interleave here.
        // Count pending change tokens (status='transferring') so concurrent sends
        // queue instead of failing with SEND_INSUFFICIENT_BALANCE.
        let pendingChangeAmount = 0n;
        for (const [, t] of this.tokens) {
          if (t.coinId === request.coinId && t.status === 'transferring') {
            pendingChangeAmount += BigInt(t.amount || '0');
          }
        }

        const planResult = this.spendPlanner.planSend(
          request, parsedPool, this.reservationLedger, this.spendQueue, result.id, pendingChangeAmount
        );

        if (planResult === 'queued') {
          // Wait for change tokens to arrive and wake this entry
          const queueResult = await this.spendQueue.waitForEntry(result.id);
          splitPlan = queueResult.splitPlan;
        } else {
          splitPlan = planResult.splitPlan;
        }
      }

      if (!splitPlan) {
        throw new SphereError('Insufficient balance', 'SEND_INSUFFICIENT_BALANCE');
      }

      // Collect all tokens involved
      const tokensToSend: Token[] = splitPlan.tokensToTransferDirectly.map((t: TokenWithAmount) => t.uiToken);
      if (splitPlan.tokenToSplit) {
        tokensToSend.push(splitPlan.tokenToSplit.uiToken);
      }
      result.tokens = tokensToSend;

      // Mark as transferring and persist — UI shows "Pending" badge immediately
      for (const token of tokensToSend) {
        token.status = 'transferring';
        this.tokens.set(token.id, token);
        this.parsedTokenCache.delete(token.id);
      }
      await this.save();

      // Save to outbox for recovery
      await this.saveToOutbox(result, recipientPubkey);

      result.status = 'submitted';

      // Use resolved peerInfo for history metadata (nametag, directAddress)
      const recipientNametag = peerInfo?.nametag
        || (request.recipient.startsWith('@') ? request.recipient.slice(1) : undefined);

      const onChainMessage = parseInvoiceMemoForOnChain(
        request.memo,
        request.invoiceRefundAddress,
        request.invoiceContact,
      );

      {
        // =================================================================
        // v2 ENGINE MODE (sender-driven): engine.transfer hands the recipient
        // a FINISHED token — no commitment / inclusion-proof / finalization.
        // =================================================================
        const engine = this.deps.tokenEngine;
        const recipientChainPubkey = hexToBytes(peerInfo.chainPubkey);
        // On-chain memo: the structured invoice ref ({inv:{id,dir}}) for invoice
        // payments, else null — plain memos stay transport-only (privacy).
        // parseInvoiceMemoForOnChain already produced the encoded bytes (or null).
        const memoData = onChainMessage ?? undefined;

        // Whole-token direct transfers.
        for (const tw of splitPlan.tokensToTransferDirectly) {
          const finished = await engine.transfer(
            {
              token: tw.sdkToken as SphereToken,
              recipientPubkey: recipientChainPubkey,
              data: memoData,
            },
            { signal: AbortSignal.timeout(SEND_ENGINE_OP_TIMEOUT_MS) },
          );
          // The source state is spent on-chain from here on.
          committedOnChainTokenIds.add(tw.uiToken.id);
          // Journal-first then deliver (courier-primary, Nostr fallback): a transport
          // failure or crash must not lose the recipient's token (replayed on load()).
          const tokenBlob = bytesToHex(encodeTokenBlob(engine.encodeToken(finished)));
          await this.deliverFinishedBlob(tokenBlob, {
            transferId: result.id,
            recipientPubkey,
            recipientChainPubkey: peerInfo.chainPubkey,
            memo: request.memo,
          });
          result.tokenTransfers.push({ sourceTokenId: tw.uiToken.id, method: 'direct' });
          await this.removeToken(tw.uiToken.id, result.id);
        }

        // Value-conserving split: recipient gets splitAmount, this wallet keeps
        // the remainder. The change token is real + immediate (the engine mints
        // it) — no placeholder / background-proof step.
        if (splitPlan.requiresSplit && splitPlan.tokenToSplit) {
          const selfChainPubkey = hexToBytes(this.deps.identity.chainPubkey);
          const { outputs } = await engine.split(
            {
              token: splitPlan.tokenToSplit.sdkToken as SphereToken,
              outputs: [
                { recipientPubkey: recipientChainPubkey, coinId: request.coinId, amount: splitPlan.splitAmount!, data: memoData },
                { recipientPubkey: selfChainPubkey, coinId: request.coinId, amount: splitPlan.remainderAmount! },
              ],
            },
            { signal: AbortSignal.timeout(SEND_ENGINE_OP_TIMEOUT_MS) },
          );
          // The split source is burnt on-chain from here on. Persist BOTH outputs
          // (journal the recipient's blob, store our change token) BEFORE the
          // delivery attempt — nothing after the on-chain split may depend on
          // the transport succeeding.
          committedOnChainTokenIds.add(splitPlan.tokenToSplit.uiToken.id);
          const recipientBlob = bytesToHex(encodeTokenBlob(engine.encodeToken(outputs[0])));
          await this.storeEngineToken(engine, outputs[1]); // change token, confirmed (BEFORE delivery)

          await this.deliverFinishedBlob(recipientBlob, {
            transferId: result.id,
            recipientPubkey,
            recipientChainPubkey: peerInfo.chainPubkey,
            memo: request.memo,
          });

          result.tokenTransfers.push({ sourceTokenId: splitPlan.tokenToSplit.uiToken.id, method: 'split' });
          await this.removeToken(splitPlan.tokenToSplit.uiToken.id, result.id);
        }
      }

      result.status = 'delivered';

      // Save state and remove outbox entry
      await this.save();
      await this.removeFromOutbox(result.id);

      result.status = 'completed';

      // Build token breakdown using a Map for O(1) lookup
      const tokenMap = new Map(result.tokens.map(t => [t.id, t]));
      const sentTokenIds: Array<{ id: string; amount: string; source: 'split' | 'direct' }> = result.tokenTransfers.map(tt => ({
        id: tt.sourceTokenId,
        // For split tokens, use splitAmount (the portion sent), not the original token amount
        amount: tt.method === 'split'
          ? (splitPlan.splitAmount?.toString() || '0')
          : (tokenMap.get(tt.sourceTokenId)?.amount || '0'),
        source: tt.method === 'split' ? 'split' : 'direct',
      }));
      const sentTokenId = result.tokens[0] ? extractTokenIdFromSdkData(result.tokens[0].sdkData) : undefined;

      await this.addToHistory({
        type: 'SENT',
        amount: request.amount,
        coinId: request.coinId,
        symbol: this.getCoinSymbol(request.coinId),
        timestamp: Date.now(),
        recipientPubkey,
        recipientNametag,
        recipientAddress: peerInfo?.directAddress || recipientPubkey,
        memo: request.memo,
        transferId: result.id,
        tokenId: sentTokenId || undefined,
        tokenIds: sentTokenIds.length > 0 ? sentTokenIds : undefined,
      });

      // Commit reservation — all tokens have been sent on-chain and removed.
      this.reservationLedger.commit(result.id);

      this.deps!.emitEvent('transfer:confirmed', result);
      return result;
    } catch (error) {
      // Cancel reservation — free reserved amounts for other sends
      this.reservationLedger.cancel(result.id);

      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);

      // Restore tokens. Three classes (W23-R2/R3, v2 edition):
      //  - already removeToken()'d during a partially-successful loop → skip
      //    (restoring would create phantom tokens);
      //  - certified on-chain during THIS send (tracked, or — for ops that threw
      //    mid-flight, e.g. an inclusion-proof timeout AFTER certification — the
      //    network says spent) → terminal 'spent', NEVER back to 'confirmed'
      //    (a spent state in the spend pool just fails every future send);
      //  - genuinely untouched → restore 'confirmed' + re-cache for the queue.
      const restoreEngine = this.deps?.tokenEngine;
      for (const token of result.tokens) {
        if (!this.tokens.has(token.id)) {
          logger.warn('Payments', `Skipping restoration of already-removed token ${token.id}`);
          continue;
        }
        let spentOnChain = committedOnChainTokenIds.has(token.id);
        if (!spentOnChain && restoreEngine && token.sdkData && looksLikeTokenBlob(token.sdkData)) {
          try {
            const st = await restoreEngine.decodeToken(decodeTokenBlob(hexToBytes(token.sdkData)));
            spentOnChain = await restoreEngine.isSpent(st);
          } catch {
            // Network/decode failure — restore optimistically; validate() or the
            // next send attempt reconciles a stale state.
          }
        }
        if (spentOnChain) {
          token.status = 'spent';
          this.tokens.set(token.id, token);
          logger.warn('Payments', `Token ${token.id} was spent on-chain during the failed send — marked 'spent' (output blob journaled for delivery replay)`);
        } else {
          token.status = 'confirmed';
          this.tokens.set(token.id, token);
          await this.cacheEngineParsedToken(token);
        }
      }

      // Persist the restore — without this a crash right after a handled failure
      // reloads the tokens as stuck-'transferring'.
      try {
        await this.save();
      } catch (saveErr) {
        logger.error('Payments', 'Failed to persist send-failure restore:', saveErr);
      }
      // The pre-send outbox snapshot can recover nothing (finished blobs are
      // journaled in PENDING_V2_DELIVERIES) — prune it on failure too.
      try {
        await this.removeFromOutbox(result.id);
      } catch { /* best-effort */ }

      // Notify queue AFTER cache is rebuilt so queued entries see restored tokens
      this.spendQueue.notifyChange(request.coinId);

      this.deps!.emitEvent('transfer:failed', result);
      throw error;
    } finally {
      resolveSendTracker();
    }
  }

  /**
   * Get coin symbol from coinId
   */
  private getCoinSymbol(coinId: string): string {
    return TokenRegistry.getInstance().getSymbol(coinId);
  }

  /**
   * Get coin name from coinId
   */
  private getCoinName(coinId: string): string {
    return TokenRegistry.getInstance().getName(coinId);
  }

  /**
   * Get coin decimals from coinId
   */
  private getCoinDecimals(coinId: string): number {
    return TokenRegistry.getInstance().getDecimals(coinId);
  }

  /**
   * Get coin icon URL from coinId
   */
  private getCoinIconUrl(coinId: string): string | undefined {
    return TokenRegistry.getInstance().getIconUrl(coinId) ?? undefined;
  }

  /**
   * Rebuild parsedTokenCache from current confirmed tokens.
   * Called after loadFromStorageData() which bypasses addToken().
   */
  private async rebuildParsedTokenCache(): Promise<void> {
    this.parsedTokenCache.clear();
    for (const [, token] of this.tokens) {
      if (token.status !== 'confirmed' || !token.sdkData) continue;
      await this.cacheEngineParsedToken(token);
    }
  }

  // ===========================================================================
  // Public API - Payment Requests
  // ===========================================================================

  /**
   * Send a payment request to someone
   * @param recipientPubkeyOrNametag - Recipient's pubkey or @nametag
   * @param request - Payment request details
   * @returns Result with event ID
   */
  async sendPaymentRequest(
    recipientPubkeyOrNametag: string,
    request: Omit<PaymentRequest, 'id' | 'createdAt'>
  ): Promise<PaymentRequestResult> {
    this.ensureInitialized();

    if (!this.deps!.transport.sendPaymentRequest) {
      return {
        success: false,
        error: 'Transport provider does not support payment requests',
      };
    }

    try {
      // Resolve recipient
      const peerInfo = await this.deps!.transport.resolve?.(recipientPubkeyOrNametag) ?? null;
      const recipientPubkey = this.resolveTransportPubkey(recipientPubkeyOrNametag, peerInfo);

      // Build payload
      const payload: PaymentRequestPayload = {
        amount: request.amount,
        coinId: request.coinId,
        message: request.message,
        recipientNametag: request.recipientNametag,
        metadata: request.metadata,
      };

      // Send via transport
      const eventId = await this.deps!.transport.sendPaymentRequest(recipientPubkey, payload);
      const requestId = crypto.randomUUID();

      // Track outgoing request
      const outgoingRequest: OutgoingPaymentRequest = {
        id: requestId,
        eventId,
        recipientPubkey,
        recipientNametag: recipientPubkeyOrNametag.startsWith('@')
          ? recipientPubkeyOrNametag.slice(1)
          : undefined,
        amount: request.amount,
        coinId: request.coinId,
        message: request.message,
        createdAt: Date.now(),
        status: 'pending',
      };
      this.outgoingPaymentRequests.set(requestId, outgoingRequest);

      logger.debug('Payments', `Payment request sent: ${eventId}`);

      return {
        success: true,
        requestId,
        eventId,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.debug('Payments', `Failed to send payment request: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Subscribe to incoming payment requests
   * @param handler - Handler function for incoming requests
   * @returns Unsubscribe function
   */
  onPaymentRequest(handler: PaymentRequestHandler): () => void {
    this.paymentRequestHandlers.add(handler);
    return () => this.paymentRequestHandlers.delete(handler);
  }

  /**
   * Get all payment requests
   * @param filter - Optional status filter
   */
  getPaymentRequests(filter?: { status?: PaymentRequestStatus }): IncomingPaymentRequest[] {
    if (filter?.status) {
      return this.paymentRequests.filter((r) => r.status === filter.status);
    }
    return [...this.paymentRequests];
  }

  /**
   * Get the count of payment requests with status `'pending'`.
   *
   * @returns Number of pending incoming payment requests.
   */
  getPendingPaymentRequestsCount(): number {
    return this.paymentRequests.filter((r) => r.status === 'pending').length;
  }

  /**
   * Accept a payment request and notify the requester.
   *
   * Marks the request as `'accepted'` and sends a response via transport.
   * The caller should subsequently call {@link send} to fulfill the payment.
   *
   * @param requestId - ID of the incoming payment request to accept.
   */
  async acceptPaymentRequest(requestId: string): Promise<void> {
    this.updatePaymentRequestStatus(requestId, 'accepted');
    await this.sendPaymentRequestResponse(requestId, 'accepted');
  }

  /**
   * Reject a payment request and notify the requester.
   *
   * @param requestId - ID of the incoming payment request to reject.
   */
  async rejectPaymentRequest(requestId: string): Promise<void> {
    this.updatePaymentRequestStatus(requestId, 'rejected');
    await this.sendPaymentRequestResponse(requestId, 'rejected');
  }

  /**
   * Mark a payment request as paid (local status update only).
   *
   * Typically called after a successful {@link send} to record that the
   * request has been fulfilled.
   *
   * @param requestId - ID of the incoming payment request to mark as paid.
   */
  markPaymentRequestPaid(requestId: string): void {
    this.updatePaymentRequestStatus(requestId, 'paid');
  }

  /**
   * Remove all non-pending incoming payment requests from memory.
   *
   * Keeps only requests with status `'pending'`.
   */
  clearProcessedPaymentRequests(): void {
    this.paymentRequests = this.paymentRequests.filter((r) => r.status === 'pending');
  }

  /**
   * Remove a specific incoming payment request by ID.
   *
   * @param requestId - ID of the payment request to remove.
   */
  removePaymentRequest(requestId: string): void {
    this.paymentRequests = this.paymentRequests.filter((r) => r.id !== requestId);
  }

  /**
   * Pay a payment request directly
   * Convenience method that accepts, sends, and marks as paid
   */
  async payPaymentRequest(requestId: string, memo?: string): Promise<TransferResult> {
    const request = this.paymentRequests.find((r) => r.id === requestId);
    if (!request) {
      throw new SphereError(`Payment request not found: ${requestId}`, 'VALIDATION_ERROR');
    }

    if (request.status !== 'pending' && request.status !== 'accepted') {
      throw new SphereError(`Payment request is not pending or accepted: ${request.status}`, 'VALIDATION_ERROR');
    }

    // Mark as accepted (don't send response yet, wait for payment)
    this.updatePaymentRequestStatus(requestId, 'accepted');

    try {
      // Send the payment
      const result = await this.send({
        coinId: request.coinId,
        amount: request.amount,
        recipient: request.senderPubkey,
        memo: memo || request.message,
      });

      // Mark as paid and send response with transfer ID
      this.updatePaymentRequestStatus(requestId, 'paid');
      await this.sendPaymentRequestResponse(requestId, 'paid', result.id);

      return result;
    } catch (error) {
      // Revert to pending on failure
      this.updatePaymentRequestStatus(requestId, 'pending');
      throw error;
    }
  }

  private updatePaymentRequestStatus(requestId: string, status: PaymentRequestStatus): void {
    const request = this.paymentRequests.find((r) => r.id === requestId);
    if (request) {
      request.status = status;

      // Emit event
      const eventType = `payment_request:${status}` as const;
      if (eventType === 'payment_request:accepted' ||
          eventType === 'payment_request:rejected' ||
          eventType === 'payment_request:paid') {
        this.deps?.emitEvent(eventType, request);
      }
    }
  }

  private handleIncomingPaymentRequest(transportRequest: TransportPaymentRequest): void {
    // Check for duplicates
    if (this.paymentRequests.find((r) => r.id === transportRequest.id)) {
      return;
    }

    // Convert transport request to IncomingPaymentRequest
    const coinId = transportRequest.request.coinId;
    const registry = TokenRegistry.getInstance();
    const coinDef = registry.getDefinition(coinId);

    const request: IncomingPaymentRequest = {
      id: transportRequest.id,
      senderPubkey: transportRequest.senderTransportPubkey,
      senderNametag: transportRequest.senderNametag,
      amount: transportRequest.request.amount,
      coinId,
      symbol: coinDef?.symbol || coinId.slice(0, 8),
      message: transportRequest.request.message,
      recipientNametag: transportRequest.request.recipientNametag,
      requestId: transportRequest.request.requestId,
      timestamp: transportRequest.timestamp,
      status: 'pending',
      metadata: transportRequest.request.metadata,
    };

    // Add to list (newest first)
    this.paymentRequests.unshift(request);

    // Emit event
    this.deps?.emitEvent('payment_request:incoming', request);

    // Notify handlers
    for (const handler of this.paymentRequestHandlers) {
      try {
        handler(request);
      } catch (error) {
        logger.debug('Payments', 'Payment request handler error:', error);
      }
    }

    logger.debug('Payments', `Incoming payment request: ${request.id} for ${request.amount} ${request.symbol}`);
  }

  // ===========================================================================
  // Public API - Outgoing Payment Requests
  // ===========================================================================

  /**
   * Get outgoing payment requests
   * @param filter - Optional status filter
   */
  getOutgoingPaymentRequests(filter?: { status?: PaymentRequestStatus }): OutgoingPaymentRequest[] {
    const requests = Array.from(this.outgoingPaymentRequests.values());
    if (filter?.status) {
      return requests.filter((r) => r.status === filter.status);
    }
    return requests;
  }

  /**
   * Subscribe to payment request responses (for outgoing requests)
   * @param handler - Handler function for incoming responses
   * @returns Unsubscribe function
   */
  onPaymentRequestResponse(handler: PaymentRequestResponseHandler): () => void {
    this.paymentRequestResponseHandlers.add(handler);
    return () => this.paymentRequestResponseHandlers.delete(handler);
  }

  /**
   * Wait for a response to a payment request
   * @param requestId - The outgoing request ID to wait for
   * @param timeoutMs - Timeout in milliseconds (default: 60000)
   * @returns Promise that resolves with the response or rejects on timeout
   */
  waitForPaymentResponse(requestId: string, timeoutMs: number = 60000): Promise<PaymentRequestResponse> {
    const outgoing = this.outgoingPaymentRequests.get(requestId);
    if (!outgoing) {
      return Promise.reject(new Error(`Outgoing payment request not found: ${requestId}`));
    }

    // If already has a response, return it
    if (outgoing.response) {
      return Promise.resolve(outgoing.response);
    }

    // Create a promise that resolves when response arrives or times out
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponseResolvers.delete(requestId);
        // Update status to expired
        const request = this.outgoingPaymentRequests.get(requestId);
        if (request && request.status === 'pending') {
          request.status = 'expired';
        }
        reject(new Error(`Payment request response timeout: ${requestId}`));
      }, timeoutMs);

      this.pendingResponseResolvers.set(requestId, { resolve, reject, timeout });
    });
  }

  /**
   * Cancel an active {@link waitForPaymentResponse} call.
   *
   * The pending promise is rejected with a `'Cancelled'` error.
   *
   * @param requestId - The outgoing request ID whose wait should be cancelled.
   */
  cancelWaitForPaymentResponse(requestId: string): void {
    const resolver = this.pendingResponseResolvers.get(requestId);
    if (resolver) {
      clearTimeout(resolver.timeout);
      resolver.reject(new Error('Cancelled'));
      this.pendingResponseResolvers.delete(requestId);
    }
  }

  /**
   * Remove an outgoing payment request and cancel any pending wait.
   *
   * @param requestId - ID of the outgoing request to remove.
   */
  removeOutgoingPaymentRequest(requestId: string): void {
    this.outgoingPaymentRequests.delete(requestId);
    this.cancelWaitForPaymentResponse(requestId);
  }

  /**
   * Remove all outgoing payment requests that are `'paid'`, `'rejected'`, or `'expired'`.
   */
  clearCompletedOutgoingPaymentRequests(): void {
    for (const [id, request] of this.outgoingPaymentRequests) {
      if (request.status === 'paid' || request.status === 'rejected' || request.status === 'expired') {
        this.outgoingPaymentRequests.delete(id);
      }
    }
  }

  private handlePaymentRequestResponse(transportResponse: TransportPaymentRequestResponse): void {
    // Find the outgoing request by matching requestId
    let outgoingRequest: OutgoingPaymentRequest | undefined;
    let outgoingRequestId: string | undefined;

    for (const [id, request] of this.outgoingPaymentRequests) {
      // Match by eventId or requestId from the response
      if (request.eventId === transportResponse.response.requestId ||
          request.id === transportResponse.response.requestId) {
        outgoingRequest = request;
        outgoingRequestId = id;
        break;
      }
    }

    // Convert transport response to PaymentRequestResponse
    const response: PaymentRequestResponse = {
      id: transportResponse.id,
      responderPubkey: transportResponse.responderTransportPubkey,
      requestId: transportResponse.response.requestId,
      responseType: transportResponse.response.responseType,
      message: transportResponse.response.message,
      transferId: transportResponse.response.transferId,
      timestamp: transportResponse.timestamp,
    };

    // Update outgoing request if found
    if (outgoingRequest && outgoingRequestId) {
      outgoingRequest.status = response.responseType === 'paid' ? 'paid' :
                               response.responseType === 'accepted' ? 'accepted' :
                               'rejected';
      outgoingRequest.response = response;

      // Resolve pending promise if any
      const resolver = this.pendingResponseResolvers.get(outgoingRequestId);
      if (resolver) {
        clearTimeout(resolver.timeout);
        resolver.resolve(response);
        this.pendingResponseResolvers.delete(outgoingRequestId);
      }
    }

    // Emit event
    this.deps?.emitEvent('payment_request:response', response);

    // Notify handlers
    for (const handler of this.paymentRequestResponseHandlers) {
      try {
        handler(response);
      } catch (error) {
        logger.debug('Payments', 'Payment request response handler error:', error);
      }
    }

    logger.debug('Payments', `Received payment request response: ${response.id} type: ${response.responseType}`);
  }

  /**
   * Send a response to a payment request (used internally by accept/reject/pay methods)
   */
  private async sendPaymentRequestResponse(
    requestId: string,
    responseType: 'accepted' | 'rejected' | 'paid',
    transferId?: string
  ): Promise<void> {
    const request = this.paymentRequests.find((r) => r.id === requestId);
    if (!request) return;

    if (!this.deps?.transport.sendPaymentRequestResponse) {
      logger.debug('Payments', 'Transport does not support sendPaymentRequestResponse');
      return;
    }

    try {
      const payload: PaymentRequestResponsePayload = {
        requestId: request.requestId, // Original request ID from sender
        responseType,
        transferId,
      };

      await this.deps.transport.sendPaymentRequestResponse(request.senderPubkey, payload);
      logger.debug('Payments', `Sent payment request response: ${responseType} for ${requestId}`);
    } catch (error) {
      logger.debug('Payments', 'Failed to send payment request response:', error);
    }
  }

  // ===========================================================================
  // Public API - Receive
  // ===========================================================================

  /**
   * Fetch and process pending incoming transfers from the transport layer.
   *
   * Performs a one-shot query to fetch all pending events, processes them
   * through the existing pipeline, and resolves after all stored events
   * are handled. Useful for batch/CLI apps that need explicit receive.
   *
   * v2 transfers arrive as FINISHED tokens, so there is no finalization phase —
   * a received token is stored confirmed immediately.
   *
   * @param _options - Deprecated; the v1 finalization options are ignored.
   * @param callback - Optional callback invoked for each newly received transfer
   * @returns ReceiveResult with the newly received transfers
   */
  async receive(
    _options?: ReceiveOptions,
    callback?: (transfer: IncomingTransfer) => void,
  ): Promise<ReceiveResult> {
    this.ensureInitialized();

    if (!this.deps!.transport.fetchPendingEvents) {
      throw new SphereError('Transport provider does not support fetchPendingEvents', 'TRANSPORT_ERROR');
    }

    // Snapshot token keys before fetch
    const tokensBefore = new Set(this.tokens.keys());

    // Fetch and process — events flow through handleIncomingTransfer() pipeline.
    // fetchPendingEvents() collects events until EOSE, then processes sequentially
    // with await. Event dedup in the transport layer prevents double-processing
    // with the persistent subscription.
    await this.deps!.transport.fetchPendingEvents();

    // Also pull the courier inbox (store-and-forward) so an explicit receive() sees
    // courier-delivered transfers too. Awaited here (unlike load()'s fire-and-forget)
    // so the reload below captures them; a no-op without a deliveryTransport. A courier
    // outage must DEGRADE, never throw out of the public receive() (the Nostr pull above
    // already succeeded) — swallow + warn, the token stays in the inbox for next pull.
    await this.deps!.deliveryTransport?.receive?.().catch((err: unknown) =>
      logger.warn('Payments', 'Courier receive (receive) failed:', err));

    // Reload from storage to get a clean, consistent state.
    // Handlers save tokens during processing (with potentially different IDs for
    // V5 pending tokens vs finalized tokens). load() clears the in-memory map
    // and reloads from TXF + pending V5 storage, ensuring no duplicates.
    await this.load();

    // Identify newly added tokens
    const received: IncomingTransfer[] = [];
    for (const [tokenId, token] of this.tokens) {
      if (!tokensBefore.has(tokenId)) {
        const transfer: IncomingTransfer = {
          id: tokenId,
          senderPubkey: '',
          tokens: [token],
          receivedAt: Date.now(),
        };
        received.push(transfer);
        if (callback) callback(transfer);
      }
    }

    return { transfers: received };
  }

  // ===========================================================================
  // Public API - Balance & Tokens
  // ===========================================================================

  /**
   * Set or update price provider
   */
  setPriceProvider(provider: PriceProvider): void {
    this.priceProvider = provider;
  }

  /**
   * Wait for all pending background operations (e.g., instant split change token creation).
   * Call this before process exit to ensure all tokens are saved.
   */
  async waitForPendingOperations(): Promise<void> {
    logger.debug('Payments', `waitForPendingOperations: ${this.pendingBackgroundTasks.length} pending tasks`);
    if (this.pendingBackgroundTasks.length > 0) {
      logger.debug('Payments', 'waitForPendingOperations: waiting...');
      await Promise.allSettled(this.pendingBackgroundTasks);
      this.pendingBackgroundTasks = [];
      logger.debug('Payments', 'waitForPendingOperations: all tasks completed');
    }
  }

  /**
   * Get total portfolio value in USD.
   * Returns null if PriceProvider is not configured.
   */
  async getFiatBalance(): Promise<number | null> {
    const assets = await this.getAssets();

    if (!this.priceProvider || this.isPriceDisabled()) {
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
   * Each entry includes confirmed and unconfirmed breakdowns. Tokens with
   * status `'spent'`, `'invalid'`, or `'transferring'` are excluded.
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
   * Includes both confirmed and unconfirmed tokens with breakdown.
   */
  async getAssets(coinId?: string): Promise<Asset[]> {
    const rawAssets = this.aggregateTokens(coinId);

    // Fetch prices if provider is available
    if (!this.priceProvider || this.isPriceDisabled() || rawAssets.length === 0) {
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
        const prices = await this.priceProvider.getPrices(tokenNames);

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
   * Aggregate tokens by coinId with confirmed/unconfirmed breakdown.
   * Excludes tokens with status 'spent' or 'invalid'.
   * Tokens with status 'transferring' are counted as unconfirmed (visible in UI as "Sending").
   */
  private aggregateTokens(coinId?: string): Asset[] {
    const assetsMap = new Map<string, {
      coinId: string;
      symbol: string;
      name: string;
      decimals: number;
      iconUrl?: string;
      confirmedAmount: bigint;
      unconfirmedAmount: bigint;
      confirmedTokenCount: number;
      unconfirmedTokenCount: number;
      transferringTokenCount: number;
    }>();

    for (const token of this.tokens.values()) {
      // Skip spent and invalid tokens; transferring tokens remain visible
      if (token.status === 'spent' || token.status === 'invalid') continue;
      if (coinId && token.coinId !== coinId) continue;

      const key = token.coinId;
      const amount = BigInt(token.amount);
      const isConfirmed = token.status === 'confirmed';
      const isTransferring = token.status === 'transferring';
      const existing = assetsMap.get(key);

      if (existing) {
        if (isConfirmed) {
          existing.confirmedAmount += amount;
          existing.confirmedTokenCount++;
        } else {
          existing.unconfirmedAmount += amount;
          existing.unconfirmedTokenCount++;
        }
        if (isTransferring) existing.transferringTokenCount++;
      } else {
        assetsMap.set(key, {
          coinId: token.coinId,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          iconUrl: token.iconUrl,
          confirmedAmount: isConfirmed ? amount : 0n,
          unconfirmedAmount: isConfirmed ? 0n : amount,
          confirmedTokenCount: isConfirmed ? 1 : 0,
          unconfirmedTokenCount: isConfirmed ? 0 : 1,
          transferringTokenCount: isTransferring ? 1 : 0,
        });
      }
    }

    return Array.from(assetsMap.values()).map((raw) => {
      const totalAmount = (raw.confirmedAmount + raw.unconfirmedAmount).toString();
      return {
        coinId: raw.coinId,
        symbol: raw.symbol,
        name: raw.name,
        decimals: raw.decimals,
        iconUrl: raw.iconUrl,
        totalAmount,
        tokenCount: raw.confirmedTokenCount + raw.unconfirmedTokenCount,
        confirmedAmount: raw.confirmedAmount.toString(),
        unconfirmedAmount: raw.unconfirmedAmount.toString(),
        confirmedTokenCount: raw.confirmedTokenCount,
        unconfirmedTokenCount: raw.unconfirmedTokenCount,
        transferringTokenCount: raw.transferringTokenCount,
        priceUsd: null,
        priceEur: null,
        change24h: null,
        fiatValueUsd: null,
        fiatValueEur: null,
      };
    });
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
    let tokens = Array.from(this.tokens.values());

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
    const token = this.tokens.get(id);
    if (!token) {
      logger.debug('Payments', `getToken: not found id=${id.slice(0, 16)}... mapSize=${this.tokens.size}`);
    }
    return token;
  }

  // ===========================================================================
  // Public API - Token Operations
  // ===========================================================================

  /**
   * Add a token to the wallet.
   *
   * Tokens are uniquely identified by a `(tokenId, stateHash)` composite key.
   * Duplicate detection:
   * - **Tombstoned** — rejected if the exact `(tokenId, stateHash)` pair has a tombstone.
   * - **Exact duplicate** — rejected if a token with the same composite key already exists.
   * - **State replacement** — if the same `tokenId` exists with a *different* `stateHash`,
   *   the old state is archived and replaced with the incoming one.
   *
   * @param token - The token to add.
   * @returns `true` if the token was added, `false` if rejected as duplicate or tombstoned.
   */
  async addToken(token: Token): Promise<boolean> {
    this.ensureInitialized();

    logger.debug('Payments', `addToken called: id=${token.id.slice(0, 16)}... coinId=${token.coinId.slice(0, 16)}... status=${token.status}`);

    const incomingTokenId = extractTokenIdFromSdkData(token.sdkData);
    const incomingStateHash = extractStateHashFromSdkData(token.sdkData);
    const incomingStateKey = incomingTokenId && incomingStateHash
      ? createTokenStateKey(incomingTokenId, incomingStateHash)
      : null;

    logger.debug('Payments', `addToken extract: tokenId=${incomingTokenId?.slice(0, 16) ?? 'null'} stateHash=${incomingStateHash?.slice(0, 16) ?? 'null'}`);

    // Check tombstones - reject tokens with exact (tokenId, stateHash) match
    // This prevents spent tokens from being re-added via Nostr re-delivery
    // Tokens with the same tokenId but DIFFERENT stateHash are allowed (new state)
    if (incomingTokenId && incomingStateHash && this.isStateTombstoned(incomingTokenId, incomingStateHash)) {
      logger.debug('Payments', `Rejecting tombstoned token: ${incomingTokenId.slice(0, 8)}..._${incomingStateHash.slice(0, 8)}...`);
      return false;
    }

    // Check for exact duplicate (same tokenId AND same stateHash)
    if (incomingStateKey) {
      for (const [_existingId, existing] of this.tokens) {
        if (isSameTokenState(existing, token)) {
          // Exact duplicate - same tokenId and same stateHash
          logger.debug('Payments', `Duplicate token state ignored: ${incomingTokenId?.slice(0, 8)}..._${incomingStateHash?.slice(0, 8)}...`);
          return false;
        }
      }
    }

    // Check for older states of the same token (same tokenId, different stateHash)
    // Replace older states with the new state
    for (const [existingId, existing] of this.tokens) {
      if (hasSameGenesisTokenId(existing, token)) {
        const existingStateHash = extractStateHashFromSdkData(existing.sdkData);

        // Skip if same state (already handled above)
        if (incomingStateHash && existingStateHash && incomingStateHash === existingStateHash) {
          continue;
        }

        // CASE 1: Existing token is spent/invalid - allow replacement
        if (existing.status === 'spent' || existing.status === 'invalid') {
          logger.debug('Payments', `Replacing spent/invalid token ${incomingTokenId?.slice(0, 8)}...`);
          this.tokens.delete(existingId);
          break;
        }

        // CASE 2: Different stateHash - this is a newer state of the token
        // Remove old state (it will be archived) and add new state
        if (incomingStateHash && existingStateHash && incomingStateHash !== existingStateHash) {
          logger.debug('Payments', `Token ${incomingTokenId?.slice(0, 8)}... state updated: ${existingStateHash.slice(0, 8)}... -> ${incomingStateHash.slice(0, 8)}...`);
          // Archive old state before removing
          await this.archiveToken(existing);
          this.tokens.delete(existingId);
          break;
        }

        // CASE 3: No state hashes available - use .id as heuristic
        if (!incomingStateHash || !existingStateHash) {
          if (existingId !== token.id) {
            logger.debug('Payments', `Token ${incomingTokenId?.slice(0, 8)}... .id changed, replacing`);
            await this.archiveToken(existing);
            this.tokens.delete(existingId);
            break;
          }
        }
      }
    }

    // Add the new token state
    this.tokens.set(token.id, token);
    logger.debug('Payments', `addToken: stored id=${token.id.slice(0, 16)}... mapSize=${this.tokens.size}`);

    // Archive the token (for recovery purposes)
    await this.archiveToken(token);

    await this.save();
    logger.debug('Payments', `addToken: saved id=${token.id.slice(0, 16)}...`);

    // Notify observers (e.g., AccountingModule) that a token was added
    this.notifyTokenChange(token);

    // Spend Queue: cache parsed token and wake queued sends
    if (token.sdkData && token.status === 'confirmed') {
      await this.cacheEngineParsedToken(token);
      this.spendQueue.notifyChange(token.coinId);
    }

    this.notifyTokenChange(token);

    logger.debug('Payments', `Added token ${token.id}, total: ${this.tokens.size}`);
    return true;
  }



  /**
   * Update an existing token or add it if not found.
   *
   * Looks up the token by genesis `tokenId` (from `sdkData`) first, then by
   * `token.id`. If no match is found, falls back to {@link addToken}.
   *
   * @param token - The token with updated data. Must include a valid `id`.
   */
  async updateToken(token: Token): Promise<void> {
    this.ensureInitialized();

    const incomingTokenId = extractTokenIdFromSdkData(token.sdkData);
    let found = false;

    // Find by genesis tokenId first
    let oldId: string | undefined;
    for (const [id, existing] of this.tokens) {
      const existingTokenId = extractTokenIdFromSdkData(existing.sdkData);
      if ((existingTokenId && incomingTokenId && existingTokenId === incomingTokenId) ||
          existing.id === token.id) {
        oldId = id;
        this.tokens.delete(id);
        this.tokens.set(token.id, token);
        found = true;
        break;
      }
    }

    if (!found) {
      await this.addToken(token);
      return;
    }

    // Spend Queue: remove stale cache entry for old id, update for new token
    if (oldId) {
      this.parsedTokenCache.delete(oldId);
    }
    if (token.status === 'confirmed' && token.sdkData) {
      await this.cacheEngineParsedToken(token);
      if (this.parsedTokenCache.has(token.id)) {
        this.spendQueue.notifyChange(token.coinId);
      }
    }

    // Archive the updated token
    await this.archiveToken(token);

    await this.save();

    // Notify observers (e.g., AccountingModule) that a token was updated
    this.notifyTokenChange(token);

    logger.debug('Payments', `Updated token ${token.id}`);
  }

  /**
   * Remove a token from the wallet.
   *
   * The token is archived first, then a tombstone `(tokenId, stateHash)` is
   * created to prevent re-addition via Nostr re-delivery. A `SENT` history
   * entry is created unless `skipHistory` is `true`.
   *
   * @param tokenId - Local UUID of the token to remove.
   */
  async removeToken(tokenId: string, excludeReservationId?: string): Promise<void> {
    this.ensureInitialized();

    const token = this.tokens.get(tokenId);
    if (!token) return;

    // Spend Queue: cancel any OTHER active reservations referencing this token.
    // excludeReservationId prevents cancelling the caller's own in-flight reservation.
    this.reservationLedger.cancelForToken(tokenId, excludeReservationId);
    this.parsedTokenCache.delete(tokenId);

    // Archive before removing
    await this.archiveToken(token);

    // Create tombstone with exact (tokenId, stateHash) - requires both
    const tombstone = createTombstoneFromToken(token);
    if (tombstone) {
      const key = `${tombstone.tokenId}:${tombstone.stateHash}`;
      if (!this.tombstoneKeySet.has(key)) {
        this.tombstones.push(tombstone);
        this.tombstoneKeySet.add(key);
        logger.debug('Payments', `Created tombstone for ${tombstone.tokenId.slice(0, 8)}..._${tombstone.stateHash.slice(0, 8)}...`);
      }
    } else {
      // No valid tombstone could be created (missing tokenId or stateHash)
      // Token will still be removed but may be re-synced later
      logger.debug('Payments', `Warning: Could not create tombstone for token ${tokenId.slice(0, 8)}... (missing tokenId or stateHash)`);
    }

    // Remove from active tokens
    this.tokens.delete(tokenId);

    await this.save();

    // Spend Queue: wake queued entries (removal may reject waiting entries
    // or free co-reserved tokens)
    this.spendQueue.notifyChange(token.coinId);
  }


  // ===========================================================================
  // Public API - Tombstones
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
   * Merge tombstones received from a remote sync source.
   *
   * Any local token whose `(tokenId, stateHash)` matches a remote tombstone is
   * removed. The remote tombstones are then added to the local set (union merge).
   *
   * @param remoteTombstones - Tombstone entries from the remote source.
   * @returns Number of local tokens that were removed.
   */
  async mergeTombstones(remoteTombstones: TombstoneEntry[]): Promise<number> {
    this.ensureInitialized();

    let removedCount = 0;
    const tombstoneKeys = new Set(
      remoteTombstones.map(t => `${t.tokenId}:${t.stateHash}`)
    );

    // Find tokens to remove
    const tokensToRemove: Token[] = [];
    for (const token of this.tokens.values()) {
      const sdkTokenId = extractTokenIdFromSdkData(token.sdkData);
      const currentStateHash = extractStateHashFromSdkData(token.sdkData);

      const key = `${sdkTokenId}:${currentStateHash}`;
      if (tombstoneKeys.has(key)) {
        tokensToRemove.push(token);
      }
    }

    for (const token of tokensToRemove) {
      this.tokens.delete(token.id);
      logger.debug('Payments', `Removed tombstoned token ${token.id.slice(0, 8)}...`);
      removedCount++;
    }

    // Merge tombstones (union)
    for (const remoteTombstone of remoteTombstones) {
      const key = `${remoteTombstone.tokenId}:${remoteTombstone.stateHash}`;
      if (!this.tombstoneKeySet.has(key)) {
        this.tombstones.push(remoteTombstone);
        this.tombstoneKeySet.add(key);
      }
    }

    if (removedCount > 0) {
      await this.save();
    }

    return removedCount;
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
      await this.save();
      logger.debug('Payments', `Pruned tombstones from ${originalCount} to ${this.tombstones.length}`);
    }
  }

  // ===========================================================================
  // Public API - Archives
  // ===========================================================================

  /**
   * Get all archived (spent/superseded) tokens in TXF format.
   *
   * Archived tokens are kept for recovery and sync purposes. The map key is
   * the genesis token ID.
   *
   * @returns A shallow copy of the archived token map.
   */
  getArchivedTokens(): Map<string, TxfToken> {
    return new Map(this.archivedTokens);
  }

  /**
   * Get the best (most committed transactions) archived version of a token.
   *
   * Searches both archived and forked token maps and returns the version with
   * the highest number of committed transactions.
   *
   * @param tokenId - The genesis token ID to look up.
   * @returns The best TXF token version, or `null` if not found.
   */
  getBestArchivedVersion(tokenId: string): TxfToken | null {
    return findBestTokenVersion(tokenId, this.archivedTokens, this.forkedTokens);
  }

  /**
   * Merge archived tokens from a remote sync source.
   *
   * For each remote token:
   * - If missing locally, it is added.
   * - If the remote version is an incremental update of the local, it replaces it.
   * - If the histories diverge (fork), the remote version is stored via {@link storeForkedToken}.
   *
   * @param remoteArchived - Map of genesis token ID → TXF token from remote.
   * @returns Number of tokens that were updated or added locally.
   */
  async mergeArchivedTokens(remoteArchived: Map<string, TxfToken>): Promise<number> {
    let mergedCount = 0;

    for (const [tokenId, remoteTxf] of remoteArchived) {
      const existingArchive = this.archivedTokens.get(tokenId);

      if (!existingArchive) {
        this.archivedTokens.set(tokenId, remoteTxf);
        mergedCount++;
      } else if (isIncrementalUpdate(existingArchive, remoteTxf)) {
        this.archivedTokens.set(tokenId, remoteTxf);
        mergedCount++;
      } else if (!isIncrementalUpdate(remoteTxf, existingArchive)) {
        // It's a fork
        const stateHash = getCurrentStateHash(remoteTxf) || '';
        await this.storeForkedToken(tokenId, stateHash, remoteTxf);
      }
    }

    if (mergedCount > 0) {
      await this.save();
    }

    return mergedCount;
  }

  /**
   * Prune archived tokens to keep at most `maxCount` entries.
   *
   * Oldest entries (by insertion order) are removed first.
   *
   * @param maxCount - Maximum number of archived tokens to retain (default: 100).
   */
  async pruneArchivedTokens(maxCount: number = 100): Promise<void> {
    if (this.archivedTokens.size <= maxCount) return;

    const originalCount = this.archivedTokens.size;
    this.archivedTokens = pruneMapByCount(this.archivedTokens, maxCount);

    await this.save();
    logger.debug('Payments', `Pruned archived tokens from ${originalCount} to ${this.archivedTokens.size}`);
  }

  // ===========================================================================
  // Public API - Forked Tokens
  // ===========================================================================

  /**
   * Get all forked token versions.
   *
   * Forked tokens represent alternative histories detected during sync.
   * The map key is `{tokenId}_{stateHash}`.
   *
   * @returns A shallow copy of the forked tokens map.
   */
  getForkedTokens(): Map<string, TxfToken> {
    return new Map(this.forkedTokens);
  }

  /**
   * Store a forked token version (alternative history).
   *
   * No-op if the exact `(tokenId, stateHash)` key already exists.
   *
   * @param tokenId - Genesis token ID.
   * @param stateHash - State hash of this forked version.
   * @param txfToken - The TXF token data to store.
   */
  async storeForkedToken(tokenId: string, stateHash: string, txfToken: TxfToken): Promise<void> {
    const key = `${tokenId}_${stateHash}`;
    if (this.forkedTokens.has(key)) return;

    this.forkedTokens.set(key, txfToken);
    logger.debug('Payments', `Stored forked token ${tokenId.slice(0, 8)}... state ${stateHash.slice(0, 12)}...`);
    await this.save();
  }

  /**
   * Merge forked tokens from a remote sync source. Only new keys are added.
   *
   * @param remoteForked - Map of `{tokenId}_{stateHash}` → TXF token from remote.
   * @returns Number of new forked tokens added.
   */
  async mergeForkedTokens(remoteForked: Map<string, TxfToken>): Promise<number> {
    let addedCount = 0;

    for (const [key, remoteTxf] of remoteForked) {
      if (!this.forkedTokens.has(key)) {
        this.forkedTokens.set(key, remoteTxf);
        addedCount++;
      }
    }

    if (addedCount > 0) {
      await this.save();
    }

    return addedCount;
  }

  /**
   * Prune forked tokens to keep at most `maxCount` entries.
   *
   * @param maxCount - Maximum number of forked tokens to retain (default: 50).
   */
  async pruneForkedTokens(maxCount: number = 50): Promise<void> {
    if (this.forkedTokens.size <= maxCount) return;

    const originalCount = this.forkedTokens.size;
    this.forkedTokens = pruneMapByCount(this.forkedTokens, maxCount);

    await this.save();
    logger.debug('Payments', `Pruned forked tokens from ${originalCount} to ${this.forkedTokens.size}`);
  }

  // ===========================================================================
  // Public API - Transaction History
  // ===========================================================================

  /**
   * Get the transaction history sorted newest-first.
   *
   * @returns Array of {@link TransactionHistoryEntry} objects in descending timestamp order.
   */
  getHistory(): TransactionHistoryEntry[] {
    return [...this._historyCache].sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Best-effort resolve sender's DIRECT address and nametag from their transport pubkey.
   * Returns empty object if transport doesn't support resolution or lookup fails.
   */
  private async resolveSenderInfo(senderTransportPubkey: string): Promise<{
    senderAddress?: string;
    senderNametag?: string;
  }> {
    try {
      if (this.deps?.transport?.resolveTransportPubkeyInfo) {
        const peerInfo = await this.deps.transport.resolveTransportPubkeyInfo(senderTransportPubkey);
        if (peerInfo) {
          return {
            senderAddress: peerInfo.directAddress || undefined,
            senderNametag: peerInfo.nametag || undefined,
          };
        }
      }
    } catch {
      // Best-effort: ignore resolution failures
    }
    return {};
  }

  /**
   * Append an entry to the transaction history.
   *
   * A unique `id` and `dedupKey` are auto-generated. The entry is persisted to
   * the local token storage provider's `history` store (IndexedDB / file).
   * Duplicate entries with the same `dedupKey` are silently ignored (upsert).
   *
   * @param entry - History entry fields (without `id` and `dedupKey`).
   */
  async addToHistory(entry: Omit<TransactionHistoryEntry, 'id' | 'dedupKey'>): Promise<void> {
    this.ensureInitialized();

    const dedupKey = computeHistoryDedupKey(entry.type, entry.tokenId, entry.transferId);
    const historyEntry: TransactionHistoryEntry = {
      id: crypto.randomUUID(),
      dedupKey,
      ...entry,
    };

    // Persist to the local token storage provider's history store
    const provider = this.getLocalTokenStorageProvider();
    if (provider?.addHistoryEntry) {
      await provider.addHistoryEntry(historyEntry);
    }

    // Update in-memory cache (replace if same dedupKey, else append)
    const existingIdx = this._historyCache.findIndex(e => e.dedupKey === dedupKey);
    if (existingIdx >= 0) {
      this._historyCache[existingIdx] = historyEntry;
    } else {
      this._historyCache.push(historyEntry);
    }

    // Notify listeners that a history entry was saved
    this.deps!.emitEvent('history:updated', historyEntry);
  }

  /**
   * Load history from the local token storage provider into the in-memory cache.
   * Also performs one-time migration from legacy KV storage.
   */
  async loadHistory(): Promise<void> {
    const provider = this.getLocalTokenStorageProvider();
    if (provider?.getHistoryEntries) {
      this._historyCache = await provider.getHistoryEntries();

      // One-time migration from legacy KV storage
      const legacyData = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY);
      if (legacyData) {
        try {
          const legacyEntries = JSON.parse(legacyData) as TransactionHistoryEntry[];
          // Ensure legacy entries have dedupKeys for import
          const records = legacyEntries.map(e => ({
            ...e,
            dedupKey: e.dedupKey || computeHistoryDedupKey(e.type, e.tokenId, e.transferId),
          }));
          const imported = await provider.importHistoryEntries?.(records) ?? 0;
          if (imported > 0) {
            this._historyCache = await provider.getHistoryEntries();
            logger.debug('Payments', `Migrated ${imported} history entries from KV to history store`);
          }
          // Delete legacy key after successful migration
          await this.deps!.storage.remove(STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY);
        } catch {
          // Ignore corrupt legacy data
        }
      }
    } else {
      // Fallback: load from KV storage (no dedicated provider)
      const historyData = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY);
      if (historyData) {
        try {
          this._historyCache = JSON.parse(historyData);
        } catch {
          this._historyCache = [];
        }
      }
    }
  }

  /**
   * Import history entries from remote TXF data into local store.
   * Delegates to the local TokenStorageProvider's importHistoryEntries() for
   * persistent storage, with in-memory fallback.
   * Reused by both load() (initial IPFS fetch) and _doSync() (merge result).
   */
  private async importRemoteHistoryEntries(entries: HistoryRecord[]): Promise<number> {
    if (entries.length === 0) return 0;

    const provider = this.getLocalTokenStorageProvider();
    if (provider?.importHistoryEntries) {
      const imported = await provider.importHistoryEntries(entries);
      if (imported > 0) {
        // Reload cache from provider to stay in sync
        this._historyCache = await provider.getHistoryEntries!();
      }
      return imported;
    }

    // Fallback: merge into in-memory cache by dedupKey
    const existingKeys = new Set(this._historyCache.map(e => e.dedupKey));
    let imported = 0;
    for (const entry of entries) {
      if (!existingKeys.has(entry.dedupKey)) {
        this._historyCache.push(entry);
        existingKeys.add(entry.dedupKey);
        imported++;
      }
    }
    return imported;
  }

  /**
   * Get the first local token storage provider (for history operations).
   */
  private getLocalTokenStorageProvider(): TokenStorageProvider<TxfStorageDataBase> | null {
    const providers = this.getTokenStorageProviders();
    for (const [, provider] of providers) {
      if (provider.type === 'local') return provider;
    }
    // Fallback: first provider
    for (const [, provider] of providers) {
      return provider;
    }
    return null;
  }

  // ===========================================================================
  // Public API - Nametag
  // ===========================================================================

  /**
   * Set the nametag data for the current identity.
   *
   * Persists to both key-value storage and file storage (lottery compatibility).
   *
   * @param nametag - The nametag data including minted token JSON.
   */
  async setNametag(nametag: NametagData): Promise<void> {
    this.ensureInitialized();
    const idx = this.nametags.findIndex(n => n.name === nametag.name);
    if (idx >= 0) {
      this.nametags[idx] = nametag;
    } else {
      this.nametags.push(nametag);
    }
    await this.save();
    logger.debug('Payments', `Unicity ID set: ${nametag.name}`);
  }

  /**
   * Get the current (first) nametag data.
   *
   * @returns The nametag data, or `null` if no nametag is set.
   */
  getNametag(): NametagData | null {
    return this.nametags[0] ?? null;
  }

  /**
   * Get all nametag data entries.
   *
   * @returns A copy of the nametags array.
   */
  getNametags(): NametagData[] {
    return [...this.nametags];
  }

  /**
   * Check whether a nametag is currently set.
   *
   * @returns `true` if nametag data is present.
   */
  hasNametag(): boolean {
    return this.nametags.length > 0;
  }

  /**
   * Remove all nametag data from memory and storage.
   */
  async clearNametag(): Promise<void> {
    this.ensureInitialized();
    this.nametags = [];
    await this.save();
  }

  /**
   * Reload nametag data from storage providers into memory.
   *
   * Used as a recovery mechanism when `this.nametags` is unexpectedly empty
   * (e.g., wiped by sync or race condition) but nametag data exists in storage.
   */
  private async reloadNametagsFromStorage(): Promise<void> {
    const providers = this.getTokenStorageProviders();
    for (const [, provider] of providers) {
      try {
        const result = await provider.load();
        if (result.success && result.data) {
          const parsed = parseTxfStorageData(result.data);
          if (parsed.nametags.length > 0) {
            this.nametags = parsed.nametags;
            logger.debug('Payments', `Reloaded ${parsed.nametags.length} Unicity ID(s) from storage`);
            return;
          }
        }
      } catch {
        // Continue to next provider
      }
    }
  }


  /**
   * Self-mint fungible tokens to this wallet (no faucet) via the v2 token
   * engine (engine.mint — a finished token, no commitment round-trip).
   * Returns the stored token and its genesis-stable id, or an error result.
   */
  async mintFungibleToken(
    coinIdHex: string,
    amount: bigint,
  ): Promise<{ success: true; token: Token; tokenId: string } | { success: false; error: string }> {
    this.ensureInitialized();

    const engine = this.deps?.tokenEngine;
    if (engine) {
      return this.mintFungibleTokenV2(engine, coinIdHex, amount);
    }

    return { success: false, error: 'Token engine unavailable — cannot mint (v2 oracle config with trust base + gateway required).' };
  }

  /**
   * Persist a realized v2 engine token as a confirmed wallet Token. Single
   * source of truth for "engine SphereToken -> stored UI Token": serialize with
   * the wallet blob codec, derive coin/amount via parseTokenInfo, apply registry
   * overrides, key it v2_<genesis-stable tokenId>, and addToken. Reused by
   * self-mint, the send change-token path, and the v2 receive path.
   *
   * `added` is addToken's verdict — false when storage REJECTED the token
   * (tombstoned re-delivery of a since-spent state, or an exact duplicate).
   * Callers emitting receipt events must gate on it.
   */
  private async storeEngineToken(
    engine: ITokenEngine,
    token: SphereToken,
  ): Promise<{ uiToken: Token; added: boolean }> {
    // Re-encode from the decoded blob; byte-identical to the wire blob (canonical CBOR).
    const sdkData = bytesToHex(encodeTokenBlob(engine.encodeToken(token)));
    const info = await parseTokenInfo(sdkData, engine);
    const registry = TokenRegistry.getInstance();
    const uiToken: Token = {
      id: `v2_${engine.tokenId(token)}`,
      coinId: info.coinId,
      symbol: registry.getSymbol(info.coinId) || info.symbol,
      name: registry.getName(info.coinId) || info.name,
      decimals: registry.getDecimals(info.coinId) ?? info.decimals,
      amount: info.amount,
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };
    const added = await this.addToken(uiToken);
    return { uiToken, added };
  }

  /**
   * Populate the SpendQueue wake-up cache (W23) for a v2 blob token. Queued
   * concurrent sends consult parsedTokenCache synchronously when woken — a
   * change token missing from it would let them time out (SEND_QUEUE_TIMEOUT)
   * instead of spending the change. Decode failures only skip the cache entry.
   */
  private async cacheEngineParsedToken(token: Token): Promise<void> {
    const engine = this.deps?.tokenEngine;
    if (!engine || !token.sdkData || !looksLikeTokenBlob(token.sdkData)) return;
    try {
      const sphereToken = await engine.decodeToken(decodeTokenBlob(hexToBytes(token.sdkData)));
      const amount = engine.balanceOf(sphereToken, token.coinId);
      if (amount > 0n) {
        this.parsedTokenCache.set(token.id, { token, sdkToken: sphereToken, amount });
      }
    } catch (err) {
      logger.warn('Payments', `parsedTokenCache: engine decode failed for ${token.id}:`, err);
    }
  }

  /**
   * v2 engine self-mint (no faucet): build a FINISHED token via engine.mint and
   * store it (storeEngineToken) as a confirmed wallet token — no commitment /
   * inclusion-proof / finalization round-trip. Lets a fresh wallet be topped up
   * on networks where the v1 mint path is unavailable (e.g. testnet2).
   */
  private async mintFungibleTokenV2(
    engine: ITokenEngine,
    coinIdHex: string,
    amount: bigint,
  ): Promise<{ success: true; token: Token; tokenId: string } | { success: false; error: string }> {
    if (amount <= 0n) {
      return { success: false, error: 'Mint amount must be greater than zero' };
    }
    if (!/^([0-9a-f]{2})+$/.test(coinIdHex)) {
      return { success: false, error: `Invalid coin id (expected even-length lowercase hex): ${coinIdHex}` };
    }

    try {
      const minted = await engine.mint({
        recipientPubkey: engine.getIdentity().chainPubkey,
        value: { assets: [{ coinId: coinIdHex, amount }] },
      });
      const { uiToken } = await this.storeEngineToken(engine, minted);
      return { success: true, token: uiToken, tokenId: engine.tokenId(minted) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `V2 mint failed: ${msg}` };
    }
  }

  // ===========================================================================
  // Public API - Sync & Validate
  // ===========================================================================

  /**
   * Sync local token state with all configured token storage providers (IPFS, file, etc.).
   *
   * For each provider, the local data is packaged into TXF storage format, sent
   * to the provider's `sync()` method, and the merged result is applied locally.
   * Emits `sync:started`, `sync:completed`, and `sync:error` events.
   *
   * @returns Summary with counts of tokens added and removed during sync.
   */
  async sync(): Promise<{ added: number; removed: number }> {
    this.ensureInitialized();

    // Sync coalescing: if a sync is already in progress, return its promise.
    // This prevents race conditions when addTokenStorageProvider() fires a
    // fire-and-forget sync and the caller also syncs immediately after.
    if (this._syncInProgress) {
      return this._syncInProgress;
    }

    this._syncInProgress = this._doSync();
    try {
      return await this._syncInProgress;
    } finally {
      this._syncInProgress = null;
    }
  }

  private async _doSync(): Promise<{ added: number; removed: number }> {
    this.deps!.emitEvent('sync:started', { source: 'payments' });

    try {
      // Get all token storage providers
      const providers = this.getTokenStorageProviders();

      if (providers.size === 0) {
        // No providers - just save locally
        await this.save();
        this.deps!.emitEvent('sync:completed', {
          source: 'payments',
          count: this.tokens.size,
        });
        return { added: 0, removed: 0 };
      }

      // Create local data once
      const localData = await this.createStorageData();

      let totalAdded = 0;
      let totalRemoved = 0;

      // Preserve nametags — sync providers may not include _nametags in merged data
      const savedNametags = [...this.nametags];

      // Precompute this wallet's acceptable `_meta.address` set once (includes the
      // vault's XP-invariant DIRECT address) so a vault round-trip is not rejected.
      const ownAddresses = await this.ownMetaAddresses();

      // Sync with each provider
      for (const [providerId, provider] of providers) {
        try {
          const result = await provider.sync(localData);

          if (result.success && result.merged) {
            // Address guard: reject data from a DIFFERENT address.
            // Stale IPFS records may contain tokens from a previously active
            // address if a write-behind flush raced with an address switch. Accept
            // any of this wallet's own identifiers (L1 / chain pubkey / runtime
            // DIRECT:// / the vault's XP-invariant DIRECT:// reserved slot).
            const mergedMeta = (result.merged as TxfStorageDataBase)?._meta;
            if (!this.isOwnAddress(mergedMeta?.address, ownAddresses)) {
              logger.warn('Payments', `Sync: rejecting data from provider ${providerId} — address mismatch (got=${mergedMeta!.address.slice(0, 20)}... expected one of this wallet's addresses)`);
              continue;
            }

            // Snapshot tokens that can't survive TXF round-trip (V5 pending)
            // AND tokens that were added after the localData snapshot.
            // Sync can race with resolveUnconfirmed() or incoming transfers.
            const savedTokens = new Map(this.tokens);

            // Apply merged data from each provider
            this.loadFromStorageData(result.merged);

            // Restore tokens lost by loadFromStorageData()'s tokens.clear().
            // Only restore if no token with the same genesis tokenId already
            // exists (avoids duplicating tokens whose ID changed from v5split
            // to real genesis ID during TXF round-trip).
            // Build index of existing genesis tokenIds for O(1) lookup instead of O(n²).
            const existingGenesisIds = new Set<string>();
            for (const existing of this.tokens.values()) {
              const gid = extractTokenIdFromSdkData(existing.sdkData);
              if (gid) existingGenesisIds.add(gid);
            }

            let restoredCount = 0;
            for (const [tokenId, token] of savedTokens) {
              if (this.tokens.has(tokenId)) continue;

              // Check tombstones
              const sdkTokenId = extractTokenIdFromSdkData(token.sdkData);
              const stateHash = extractStateHashFromSdkData(token.sdkData);
              if (sdkTokenId && stateHash && this.isStateTombstoned(sdkTokenId, stateHash)) {
                continue;
              }

              // Skip if an equivalent token (same genesis tokenId) already
              // exists under a different ID — avoids balance doubling.
              if (sdkTokenId && existingGenesisIds.has(sdkTokenId)) {
                continue;
              }

              this.tokens.set(tokenId, token);
              if (sdkTokenId) existingGenesisIds.add(sdkTokenId);
              restoredCount++;
            }
            if (restoredCount > 0) {
              logger.debug('Payments', `Sync: restored ${restoredCount} token(s) lost by loadFromStorageData`);
            }

            // Restore nametags if sync wiped them
            if (this.nametags.length === 0 && savedNametags.length > 0) {
              this.nametags = savedNametags;
            }

            // Rebuild parsedTokenCache for spend queue (loadFromStorageData bypasses addToken)
            await this.rebuildParsedTokenCache();

            // Import merged history from IPFS sync into local store
            const txfData = result.merged as TxfStorageDataBase;
            if (txfData._history && txfData._history.length > 0) {
              const imported = await this.importRemoteHistoryEntries(txfData._history as HistoryRecord[]);
              if (imported > 0) {
                logger.debug('Payments', `Imported ${imported} history entries from IPFS sync`);
              }
            }

            totalAdded += result.added;
            totalRemoved += result.removed;
          }

          this.deps!.emitEvent('sync:provider', {
            providerId,
            success: result.success,
            added: result.added,
            removed: result.removed,
          });
        } catch (providerError) {
          // Log error but continue with other providers
          logger.warn('Payments', `Sync failed for provider ${providerId}:`, providerError);
          this.deps!.emitEvent('sync:provider', {
            providerId,
            success: false,
            error: providerError instanceof Error ? providerError.message : String(providerError),
          });
        }
      }

      // Persist merged state to primary storage so it survives process restarts
      if (totalAdded > 0 || totalRemoved > 0) {
        await this.save();
      }

      this.deps!.emitEvent('sync:completed', {
        source: 'payments',
        count: this.tokens.size,
      });

      return { added: totalAdded, removed: totalRemoved };
    } catch (error) {
      this.deps!.emitEvent('sync:error', {
        source: 'payments',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  // ===========================================================================
  // Storage Event Subscription (Push-Based Sync)
  // ===========================================================================

  /**
   * Subscribe to 'storage:remote-updated' events from all token storage providers.
   * When a provider emits this event, a debounced sync is triggered.
   */
  private subscribeToStorageEvents(): void {
    // Clean up existing subscriptions
    this.unsubscribeStorageEvents();

    const providers = this.getTokenStorageProviders();
    for (const [providerId, provider] of providers) {
      if (provider.onEvent) {
        const unsub = provider.onEvent((event) => {
          if (event.type === 'storage:remote-updated') {
            logger.debug('Payments', 'Remote update detected from provider', providerId, event.data);
            this.debouncedSyncFromRemoteUpdate(providerId, event.data);
          }
        });
        this.storageEventUnsubscribers.push(unsub);
      }
    }
  }

  /**
   * Unsubscribe from all storage provider events and clear debounce timer.
   */
  private unsubscribeStorageEvents(): void {
    for (const unsub of this.storageEventUnsubscribers) {
      unsub();
    }
    this.storageEventUnsubscribers = [];

    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
      this.syncDebounceTimer = null;
    }
  }

  /**
   * Debounced sync triggered by a storage:remote-updated event.
   * Waits 500ms to batch rapid updates, then performs sync.
   */
  private debouncedSyncFromRemoteUpdate(providerId: string, eventData: unknown): void {
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
    }

    this.syncDebounceTimer = setTimeout(() => {
      this.syncDebounceTimer = null;
      this.sync()
        .then((result) => {
          const data = eventData as { name?: string; sequence?: number; cid?: string } | undefined;
          this.deps?.emitEvent('sync:remote-update', {
            providerId,
            name: data?.name ?? '',
            sequence: data?.sequence ?? 0,
            cid: data?.cid ?? '',
            added: result.added,
            removed: result.removed,
          });
        })
        .catch((err) => {
          logger.debug('Payments', 'Auto-sync from remote update failed:', err);
        });
    }, PaymentsModule.SYNC_DEBOUNCE_MS);
  }

  /**
   * Get all active (non-disabled) token storage providers
   */
  private getTokenStorageProviders(): Map<string, TokenStorageProvider<TxfStorageDataBase>> {
    let providers: Map<string, TokenStorageProvider<TxfStorageDataBase>>;

    // Prefer new multi-provider map
    if (this.deps!.tokenStorageProviders && this.deps!.tokenStorageProviders.size > 0) {
      providers = this.deps!.tokenStorageProviders;
    } else if (this.deps!.tokenStorage) {
      // Fallback to deprecated single provider
      providers = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
      providers.set(this.deps!.tokenStorage.id, this.deps!.tokenStorage);
    } else {
      return new Map();
    }

    // Filter out disabled providers
    const disabled = this.deps!.disabledProviderIds;
    if (disabled && disabled.size > 0) {
      const filtered = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
      for (const [id, provider] of providers) {
        if (!disabled.has(id)) {
          filtered.set(id, provider);
        }
      }
      return filtered;
    }

    return providers;
  }

  /**
   * Check if the price provider is disabled via the disabled providers set.
   */
  private isPriceDisabled(): boolean {
    const disabled = this.deps?.disabledProviderIds;
    if (!disabled || disabled.size === 0) return false;
    const priceId = (this.priceProvider as Record<string, unknown> | null)?.id as string | undefined ?? 'price';
    return disabled.has(priceId);
  }

  /**
   * Replace the set of token storage providers at runtime.
   *
   * Use when providers are added or removed dynamically (e.g. IPFS node started).
   *
   * @param providers - New map of provider ID → TokenStorageProvider.
   */
  updateTokenStorageProviders(providers: Map<string, TokenStorageProvider<TxfStorageDataBase>>): void {
    if (this.deps) {
      this.deps.tokenStorageProviders = providers;
      // Re-subscribe to storage events for new providers
      this.subscribeToStorageEvents();
    }
  }

  /**
   * Validate all tokens against the aggregator (oracle provider).
   *
   * Tokens that fail validation or are detected as spent are marked `'invalid'`.
   *
   * @returns Object with arrays of valid and invalid tokens.
   */
  async validate(): Promise<{ valid: Token[]; invalid: Token[] }> {
    this.ensureInitialized();

    const valid: Token[] = [];
    const invalid: Token[] = [];

    const engine = this.deps?.tokenEngine;
    for (const token of this.tokens.values()) {
      // v2 blob tokens are verified via the engine (local proof check + on-chain
      // spent-status); the oracle's validateToken only understands v1 TXF.
      if (engine && token.sdkData && looksLikeTokenBlob(token.sdkData)) {
        try {
          const sphereToken = await engine.decodeToken(decodeTokenBlob(hexToBytes(token.sdkData)));
          const verdict = await engine.verify(sphereToken);
          const spent = verdict.ok ? await engine.isSpent(sphereToken) : false;
          if (verdict.ok && !spent) {
            valid.push(token);
          } else {
            token.status = 'invalid';
            this.parsedTokenCache.delete(token.id);
            invalid.push(token);
          }
        } catch (err) {
          // Transient failure (decode/network) — do NOT invalidate funds on an
          // outage; skip this token for this run.
          logger.warn('Payments', `validate: engine check failed for ${token.id}, skipping:`, err);
        }
        continue;
      }

      const result = await this.deps!.oracle.validateToken(token.sdkData);

      if (result.valid && !result.spent) {
        valid.push(token);
      } else {
        token.status = 'invalid';
        this.parsedTokenCache.delete(token.id);
        invalid.push(token);
      }
    }

    if (invalid.length > 0) {
      await this.save();
    }

    return { valid, invalid };
  }

  /**
   * Get all in-progress (pending) outgoing transfers.
   *
   * @returns Array of {@link TransferResult} objects for transfers that have not yet completed.
   */
  getPendingTransfers(): TransferResult[] {
    return Array.from(this.pendingTransfers.values());
  }

  // ===========================================================================
  // Private: Transfer Operations
  // ===========================================================================

  /**
   * Detect if a string is an L3 address (not a nametag)
   * Returns true for: hex pubkeys (64+ chars), PROXY:, DIRECT: prefixed addresses
   */
  /**
   * Resolve recipient to transport pubkey for messaging.
   * Uses pre-resolved PeerInfo if available, otherwise resolves via transport.
   */
  private resolveTransportPubkey(recipient: string, peerInfo?: PeerInfo | null): string {
    // If we already have PeerInfo from a prior resolve() call, use it directly
    if (peerInfo?.transportPubkey) {
      return peerInfo.transportPubkey;
    }

    // Hex pubkey (64+ hex chars) — use as transport pubkey directly
    if (recipient.length >= 64 && /^[0-9a-fA-F]+$/.test(recipient)) {
      // 66-char with 02/03 prefix — strip to 32-byte x-only
      if (recipient.length === 66 && (recipient.startsWith('02') || recipient.startsWith('03'))) {
        return recipient.slice(2);
      }
      return recipient;
    }

    throw new SphereError(
      `Cannot resolve transport pubkey for "${recipient}". ` +
      `No binding event found. The recipient must publish their identity first.`,
      'INVALID_RECIPIENT',
    );
  }

  /**
   * v2 engine transfer (sender-driven): the sender handed us a FINISHED token.
   * Decode the blob, dedup by the genesis-stable token id, store it as a
   * confirmed token, and emit/record the receipt. No commitment / inclusion-proof
   * / finalization round-trip (contrast the v1 sourceToken+transferTx path).
   */
  private async handleV2Transfer(payload: V2TransferPayload, senderPubkey: string): Promise<void> {
    this.ensureInitialized();
    if (!this.loaded && this.loadedPromise) {
      await this.loadedPromise;
    }

    const engine = this.deps!.tokenEngine;
    if (!engine) {
      logger.error('Payments', 'V2 transfer received but no token engine is configured — payload dropped. Supply the v2 oracle config (trust base + gateway URL).');
      return;
    }

    let token: SphereToken;
    try {
      token = await engine.decodeToken(decodeTokenBlob(hexToBytes(payload.tokenBlob)));
    } catch (err) {
      logger.error('Payments', 'V2 transfer: failed to decode token blob:', err);
      return;
    }

    // Security: the sender hands us a FINISHED token — verify it cryptographically
    // and confirm its final state is actually locked to this wallet before it
    // enters the balance. Both checks are local (trust base + predicate bytes).
    const verdict = await engine.verify(token);
    if (!verdict.ok) {
      logger.warn('Payments', `V2 transfer rejected: verification failed (${verdict.reason ?? 'unknown'})`);
      return;
    }
    if (!engine.isOwnedBy(token, engine.getIdentity().chainPubkey)) {
      logger.warn('Payments', 'V2 transfer rejected: token not addressed to this wallet');
      return;
    }

    // Dedup by genesis-stable id (a re-delivered identical token is ignored).
    const id = `v2_${engine.tokenId(token)}`;
    if (this.tokens.has(id)) {
      logger.debug('Payments', `V2 transfer ${id.slice(0, 16)}... already present, skipping`);
      return;
    }

    const { uiToken, added } = await this.storeEngineToken(engine, token);
    if (!added) {
      // Storage rejected it: a tombstoned re-delivery of a since-spent state, or
      // a duplicate race. Emitting transfer:incoming / writing RECEIVED history
      // here would announce a phantom payment for value the wallet does not hold.
      logger.warn('Payments', `V2 transfer ${id.slice(0, 16)}... rejected by storage (tombstoned/duplicate) — no event emitted`);
      return;
    }
    const senderInfo = await this.resolveSenderInfo(senderPubkey);

    this.deps!.emitEvent('transfer:incoming', {
      id,
      senderPubkey,
      senderNametag: senderInfo.senderNametag,
      tokens: [uiToken],
      memo: payload.memo,
      receivedAt: Date.now(),
    });

    await this.addToHistory({
      type: 'RECEIVED',
      amount: uiToken.amount,
      coinId: uiToken.coinId,
      symbol: uiToken.symbol,
      timestamp: Date.now(),
      senderPubkey,
      ...senderInfo,
      memo: payload.memo,
      tokenId: id,
    });
  }

  private async handleIncomingTransfer(transfer: IncomingTokenTransfer): Promise<void> {
    // Ensure load() has completed so dedup checks see all persisted tokens.
    if (!this.loaded && this.loadedPromise) {
      await this.loadedPromise;
    }

    try {
      // The only supported wire format is the v2 engine transfer:
      // { type: 'V2_TRANSFER', tokenBlob } carrying a FINISHED token.
      const payload = transfer.payload as unknown as Record<string, unknown>;
      logger.debug('Payments', 'handleIncomingTransfer: keys=', Object.keys(payload).join(','));

      // v2 engine transfer (sender-driven): the sender handed us a FINISHED token.
      // Decode + store directly — no commitment / proof / finalization round-trip.
      if (isV2TransferPayload(transfer.payload)) {
        await this.handleV2Transfer(transfer.payload, transfer.senderTransportPubkey);
        return;
      }

      // LEGACY v1 wire formats (V6 combined, V4/V5 instant-split, NOSTR-FIRST,
      // {sourceToken,transferTx}, plain token JSON) are no longer supported —
      // their commitment/finalization machinery was removed with the v1 engine.
      // Drop loudly so an old-version sender is diagnosable from the logs.
      const payloadType = typeof payload.type === 'string' ? payload.type : undefined;
      const looksLegacyV1 = payload.sourceToken !== undefined
        || payload.token !== undefined
        || payloadType === 'COMBINED_TRANSFER'
        || payloadType === 'INSTANT_SPLIT';
      if (looksLegacyV1) {
        logger.error(
          'Payments',
          'Dropped LEGACY v1 transfer payload (v1 support removed in 0.8.0). The sender must upgrade to a v2 wallet.',
        );
        return;
      }

      logger.warn('Payments', 'Unknown transfer payload format');
    } catch (error) {
      logger.error('Payments', 'Failed to process incoming transfer:', error);
    }
  }

  // ===========================================================================
  // Private: Archive
  // ===========================================================================

  private async archiveToken(token: Token): Promise<void> {
    const txf = tokenToTxf(token);
    if (!txf) return;

    const tokenId = txf.genesis?.data?.tokenId;
    if (!tokenId) return;

    const existingArchive = this.archivedTokens.get(tokenId);

    if (existingArchive) {
      if (isIncrementalUpdate(existingArchive, txf)) {
        this.archivedTokens.set(tokenId, txf);
        logger.debug('Payments', `Updated archived token ${tokenId.slice(0, 8)}...`);
      } else {
        // Fork
        const stateHash = getCurrentStateHash(txf) || '';
        await this.storeForkedToken(tokenId, stateHash, txf);
        logger.debug('Payments', `Archived token ${tokenId.slice(0, 8)}... is a fork`);
      }
    } else {
      this.archivedTokens.set(tokenId, txf);
      logger.debug('Payments', `Archived token ${tokenId.slice(0, 8)}...`);
    }
  }

  // ===========================================================================
  // Private: Storage
  // ===========================================================================

  private async save(): Promise<void> {
    // Save to TokenStorageProviders (IndexedDB/files)
    const providers = this.getTokenStorageProviders();
    // Debug: log token serialization status
    const tokenStats = Array.from(this.tokens.values()).map(t => {
      const txf = tokenToTxf(t);
      return `${t.id.slice(0, 12)}(${t.status},txf=${!!txf})`;
    });
    logger.debug('Payments', `save(): providers=${providers.size}, tokens=[${tokenStats.join(', ')}]`);

    if (providers.size > 0) {
      const data = await this.createStorageData();
      const dataKeys = Object.keys(data).filter(k => k.startsWith('token-'));
      logger.debug('Payments', `save(): TXF keys=${dataKeys.length} (${dataKeys.join(', ')})`);
      for (const [id, provider] of providers) {
        try {
          await provider.save(data);
        } catch (err) {
          logger.error('Payments', `Failed to save to provider ${id}:`, err);
        }
      }
    } else {
      logger.debug('Payments', 'save(): No token storage providers - TXF not persisted');
    }
  }

  private async saveToOutbox(transfer: TransferResult, recipient: string): Promise<void> {
    const outbox = await this.loadOutbox();
    outbox.push({ transfer, recipient, createdAt: Date.now() });
    await this.deps!.storage.set(STORAGE_KEYS_ADDRESS.OUTBOX, JSON.stringify(outbox));
  }

  private async removeFromOutbox(transferId: string): Promise<void> {
    const outbox = await this.loadOutbox();
    const filtered = outbox.filter((e) => e.transfer.id !== transferId);
    await this.deps!.storage.set(STORAGE_KEYS_ADDRESS.OUTBOX, JSON.stringify(filtered));
  }

  private async loadOutbox(): Promise<Array<{ transfer: TransferResult; recipient: string; createdAt: number }>> {
    const data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.OUTBOX);
    return data ? JSON.parse(data) : [];
  }

  // ===========================================================================
  // Private: Pending v2 deliveries (finished-but-undelivered token blobs)
  // ===========================================================================

  private async loadPendingV2Deliveries(): Promise<PendingV2Delivery[]> {
    const data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES);
    return data ? (JSON.parse(data) as PendingV2Delivery[]) : [];
  }

  private async savePendingV2Delivery(entry: PendingV2Delivery): Promise<void> {
    const all = await this.loadPendingV2Deliveries();
    if (!all.some((e) => e.tokenBlob === entry.tokenBlob)) {
      all.push(entry);
      await this.deps!.storage.set(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES, JSON.stringify(all));
    }
  }

  private async removePendingV2Delivery(tokenBlob: string): Promise<void> {
    const all = await this.loadPendingV2Deliveries();
    const filtered = all.filter((e) => e.tokenBlob !== tokenBlob);
    if (filtered.length !== all.length) {
      await this.deps!.storage.set(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES, JSON.stringify(filtered));
    }
  }

  /**
   * GC a courier delivery by its courier `entryId` (the entryId↔blob mapping, concern
   * 5). Bound to the courier's `onDelivered` sink: it fires ONLY after the courier has
   * verified a valid recipient ackSig, so this is the ONLY thing that removes a
   * `transport: 'courier'` journal entry. Idempotent — an unknown / already-removed
   * entryId is a no-op (a double-fired or stale onDelivered never corrupts the journal).
   */
  private async removePendingV2DeliveryByEntryId(entryId: string): Promise<void> {
    const all = await this.loadPendingV2Deliveries();
    const filtered = all.filter((e) => e.entryId !== entryId);
    if (filtered.length !== all.length) {
      await this.deps!.storage.set(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES, JSON.stringify(filtered));
    }
  }

  /**
   * Deliver ONE finished v2 token blob, journal-first (DESIGN: never lose a token).
   *
   * COEXIST POLICY (concern 4): when a `deliveryTransport` (courier) is configured it is
   * PRIMARY — the blob is journaled tagged `'courier'` (with the courier entryId folded
   * in) and deposited; the journal entry is then removed ONLY by a valid-ackSig
   * `onDelivered` (NOT here). A courier `deposit()` FAILURE falls back to Nostr (no lost
   * delivery), removing the journal entry after the send (today's behavior). With no
   * courier, delivery is Nostr-only, byte-identical to today. Resolution stayed on Nostr;
   * the courier only consumes the already-resolved `recipientChainPubkey`.
   */
  private async deliverFinishedBlob(
    tokenBlob: string,
    meta: { transferId: string; recipientPubkey: string; recipientChainPubkey: string; memo?: string },
  ): Promise<void> {
    const courier = this.deps!.deliveryTransport;
    if (courier) {
      try {
        await this.depositToCourier(courier, tokenBlob, meta);
        return; // journaled 'courier'; GC deferred to onDelivered (valid ackSig)
      } catch (err) {
        logger.warn('Payments', 'Courier deposit failed — falling back to Nostr delivery:', err);
      }
    }
    // Nostr path (primary when no courier, or the courier-deposit fallback).
    await this.savePendingV2Delivery({
      transferId: meta.transferId, recipientPubkey: meta.recipientPubkey,
      tokenBlob, memo: meta.memo, createdAt: Date.now(), transport: 'nostr',
    });
    await this.sendBlobOverNostr(meta.recipientPubkey, tokenBlob, meta.memo);
    await this.removePendingV2Delivery(tokenBlob);
  }

  /**
   * Journal the blob tagged `'courier'` THEN deposit it. Journal-first so a crash
   * between the journal and the deposit still has the entry to replay; the courier
   * deposit is idempotent (server dedups on entryId). The returned `entryId` is folded
   * onto the journal entry so `onDelivered(entryId)` can later resolve the blob to GC.
   */
  private async depositToCourier(
    courier: TokenDeliveryTransport,
    tokenBlob: string,
    meta: { transferId: string; recipientPubkey: string; recipientChainPubkey: string; memo?: string },
  ): Promise<void> {
    const envelope: TokenEnvelope = {
      recipientChainPubkey: meta.recipientChainPubkey,
      senderChainPubkey: this.deps!.identity.chainPubkey,
      transferId: meta.transferId,
      tokenBlobHex: tokenBlob,
      memo: meta.memo,
    };
    await this.savePendingV2Delivery({
      transferId: meta.transferId, recipientPubkey: meta.recipientPubkey,
      recipientChainPubkey: meta.recipientChainPubkey,
      tokenBlob, memo: meta.memo, createdAt: Date.now(), transport: 'courier',
    });
    const handle = await courier.deposit(envelope);
    await this.setPendingV2DeliveryEntryId(tokenBlob, handle.entryId);
  }

  /** Fold the courier `entryId` onto an already-journaled `'courier'` entry. */
  private async setPendingV2DeliveryEntryId(tokenBlob: string, entryId: string): Promise<void> {
    const all = await this.loadPendingV2Deliveries();
    const entry = all.find((e) => e.tokenBlob === tokenBlob);
    if (entry && entry.entryId !== entryId) {
      entry.entryId = entryId;
      await this.deps!.storage.set(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES, JSON.stringify(all));
    }
  }

  /** Send one finished blob as a V2_TRANSFER over the Nostr transport. */
  private async sendBlobOverNostr(recipientPubkey: string, tokenBlob: string, memo?: string): Promise<void> {
    await this.deps!.transport.sendTokenTransfer(recipientPubkey, {
      type: 'V2_TRANSFER',
      version: '2.0',
      tokenBlob,
      memo,
    } as unknown as import('../../transport').TokenTransferPayload);
  }

  /**
   * Replay journaled finished-but-undelivered v2 blobs (kicked fire-and-forget from
   * load()). ROUTING (concern 4): a `'courier'` entry is RE-DEPOSITED over the courier
   * (idempotent on entryId; GC stays deferred to onDelivered — NOT removed here), while
   * a `'nostr'`/untagged (legacy) entry is re-sent over Nostr and removed on success.
   * The recipient dedups re-deliveries by the genesis-stable token id, so replaying an
   * already-delivered blob is harmless. Entries that still fail are kept for next load.
   */
  private async replayPendingV2Deliveries(): Promise<void> {
    const entries = await this.loadPendingV2Deliveries();
    if (entries.length === 0) return;
    logger.warn('Payments', `${entries.length} undelivered v2 transfer(s) journaled from a previous session — replaying`);
    for (const e of entries) {
      try {
        await this.replayOneDelivery(e);
      } catch (err) {
        logger.warn('Payments', `Replay of undelivered v2 transfer ${e.transferId.slice(0, 8)}... failed (kept for next load):`, err);
      }
    }
  }

  /** Replay one journaled delivery over its tagged channel (courier re-deposit / Nostr). */
  private async replayOneDelivery(e: PendingV2Delivery): Promise<void> {
    const courier = this.deps!.deliveryTransport;
    if (e.transport === 'courier' && courier && e.recipientChainPubkey) {
      // Re-deposit; GC stays deferred to a valid-ackSig onDelivered (do NOT remove here).
      const handle = await courier.deposit({
        recipientChainPubkey: e.recipientChainPubkey,
        senderChainPubkey: this.deps!.identity.chainPubkey,
        transferId: e.transferId,
        tokenBlobHex: e.tokenBlob,
        memo: e.memo,
      });
      await this.setPendingV2DeliveryEntryId(e.tokenBlob, handle.entryId);
      logger.debug('Payments', `Re-deposited undelivered courier transfer ${e.transferId.slice(0, 8)}...`);
      return;
    }
    // Nostr / legacy entry: re-send and GC after success (today's behavior).
    await this.sendBlobOverNostr(e.recipientPubkey, e.tokenBlob, e.memo);
    await this.removePendingV2Delivery(e.tokenBlob);
    logger.debug('Payments', `Replayed undelivered v2 transfer ${e.transferId.slice(0, 8)}...`);
  }

  private async createStorageData(): Promise<TxfStorageDataBase> {
    const sorted = [...this._historyCache].sort((a, b) => b.timestamp - a.timestamp);
    return await buildTxfStorageData(
      Array.from(this.tokens.values()),
      {
        version: 1,
        address: this.deps!.identity.l1Address,
        ipnsName: this.deps!.identity.ipnsName ?? '',
      },
      {
        nametags: this.nametags,
        tombstones: this.tombstones,
        archivedTokens: this.archivedTokens,
        forkedTokens: this.forkedTokens,
        historyEntries: sorted.slice(0, MAX_SYNCED_HISTORY_ENTRIES),
      }
    ) as unknown as TxfStorageDataBase;
  }

  private loadFromStorageData(data: TxfStorageDataBase): void {
    const parsed = parseTxfStorageData(data);
    logger.debug('Payments', `loadFromStorageData: parsed ${parsed.tokens.length} tokens, ${parsed.tombstones.length} tombstones, errors=[${parsed.validationErrors.join('; ')}]`);

    // Load tombstones FIRST so we can filter tokens
    this.tombstones = parsed.tombstones;
    this.rebuildTombstoneKeySet();
    // Load tokens, filtering out tombstoned ones.
    // Preserve tokens with 'transferring' status — they are part of an in-flight send().
    const preservedTransferring = new Map<string, Token>();
    for (const [id, token] of this.tokens) {
      if (token.status === 'transferring') {
        preservedTransferring.set(id, token);
      }
    }

    this.tokens.clear();
    for (const [id, token] of preservedTransferring) {
      this.tokens.set(id, token);
    }

    for (const token of parsed.tokens) {
      // Don't overwrite in-flight tokens preserved above
      if (preservedTransferring.has(token.id)) continue;

      const sdkTokenId = extractTokenIdFromSdkData(token.sdkData);
      const stateHash = extractStateHashFromSdkData(token.sdkData);

      // Only filter if we have exact state match
      if (sdkTokenId && stateHash && this.isStateTombstoned(sdkTokenId, stateHash)) {
        logger.debug('Payments', `Skipping tombstoned token ${sdkTokenId.slice(0, 8)}... during load (exact state match)`);
        continue;
      }

      this.tokens.set(token.id, token);
    }

    // Load other data
    this.archivedTokens = parsed.archivedTokens;
    this.forkedTokens = parsed.forkedTokens;
    this.nametags = parsed.nametags;
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  private ensureInitialized(): void {
    if (!this.deps) {
      throw new SphereError('PaymentsModule not initialized', 'NOT_INITIALIZED');
    }
  }

  /**
   * The set of `_meta.address` values that identify THIS wallet's own data:
   *  - the L1 address (local TXF stores stamp this);
   *  - the chain pubkey;
   *  - the runtime DIRECT:// predicate address (`identity.directAddress`);
   *  - the vault's XP-invariant DIRECT:// address — `deriveDirectAddress(rawChainPubkey)`
   *    (RemoteTokenStorageProvider.planReservedAddress stamps THIS, which differs
   *    from the prehashed runtime predicate address, so it must be accepted explicitly
   *    or a vault restore is rejected as a foreign address and the balance is lost).
   * Computed once per load/sync; the async XP-invariant derivation never throws here
   * (a derive failure degrades to the non-vault identifiers, never blocks a load).
   */
  private async ownMetaAddresses(): Promise<Set<string>> {
    const id = this.deps!.identity;
    const own = new Set<string>([id.l1Address, id.chainPubkey]);
    if (id.directAddress) own.add(id.directAddress);
    try {
      own.add(await deriveDirectAddress(hexToBytes(id.chainPubkey)));
    } catch (err) {
      logger.warn('Payments', 'ownMetaAddresses: XP-invariant address derive failed:', err);
    }
    return own;
  }

  /**
   * True when a stored `_meta.address` is one of THIS wallet's own identifiers
   * (see {@link ownMetaAddresses}). An empty/absent stored address is permissive
   * (legacy data with no `_meta.address`); a present address must be in the own-set.
   */
  private isOwnAddress(stored: string | undefined, own: Set<string>): boolean {
    return !stored || own.has(stored);
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createPaymentsModule(config?: PaymentsModuleConfig): PaymentsModule {
  return new PaymentsModule(config);
}
