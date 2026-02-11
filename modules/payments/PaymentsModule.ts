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
import { TokenSplitCalculator } from './TokenSplitCalculator';
import { TokenSplitExecutor } from './TokenSplitExecutor';
import { NametagMinter, type MintNametagResult } from './NametagMinter';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../storage';
import type {
  TransportProvider,
  PeerInfo,
  IncomingTokenTransfer,
  PaymentRequestPayload,
  PaymentRequestResponsePayload,
  IncomingPaymentRequest as TransportPaymentRequest,
  IncomingPaymentRequestResponse as TransportPaymentRequestResponse,
} from '../../transport';
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

// Instant split imports
import { InstantSplitExecutor } from './InstantSplitExecutor';
import { InstantSplitProcessor } from './InstantSplitProcessor';
import type {
  InstantSplitBundle,
  InstantSplitBundleV5,
  InstantSplitProcessResult,
  InstantSplitOptions,
  InstantSplitResult,
  PendingV5Finalization,
  UnconfirmedResolutionResult,
} from '../../types/instant-split';
import { isInstantSplitBundle, isInstantSplitBundleV5 } from '../../types/instant-split';

// SDK imports for token parsing and transfers
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { CoinId } from '@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId';
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import { TransferTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import { AddressScheme } from '@unicitylabs/state-transition-sdk/lib/address/AddressScheme';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';
import { MintCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment';
import { MintTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';
import { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof';
import type { IAddress } from '@unicitylabs/state-transition-sdk/lib/address/IAddress';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase';

// =============================================================================
// Transaction History Entry
// =============================================================================

export interface TransactionHistoryEntry {
  id: string;
  type: 'SENT' | 'RECEIVED' | 'SPLIT' | 'MINT';
  amount: string;
  coinId: string;
  symbol: string;
  timestamp: number;
  recipientNametag?: string;
  senderPubkey?: string;
  /** TransferResult.id that created this entry (links history to transfer operation) */
  transferId?: string;
}

// =============================================================================
// Receive Options & Result
// =============================================================================

export interface ReceiveOptions {
  /** Wait for all unconfirmed tokens to be finalized (default: false).
   *  When false, calls resolveUnconfirmed() once to submit pending commitments.
   *  When true, polls resolveUnconfirmed() + load() until all confirmed or timeout. */
  finalize?: boolean;
  /** Finalization timeout in ms (default: 60000). Only used when finalize=true. */
  timeout?: number;
  /** Poll interval in ms (default: 2000). Only used when finalize=true. */
  pollInterval?: number;
  /** Progress callback after each resolveUnconfirmed() poll. Only used when finalize=true. */
  onProgress?: (result: UnconfirmedResolutionResult) => void;
}

export interface ReceiveResult {
  /** Newly received incoming transfers. */
  transfers: IncomingTransfer[];
  /** Finalization result (from resolveUnconfirmed). */
  finalization?: UnconfirmedResolutionResult;
  /** Whether finalization timed out (only when finalize=true). */
  timedOut?: boolean;
  /** Duration of finalization in ms (only when finalize=true). */
  finalizationDurationMs?: number;
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
async function parseTokenInfo(tokenData: unknown): Promise<ParsedTokenInfo> {
  const defaultInfo: ParsedTokenInfo = {
    coinId: 'ALPHA',
    symbol: 'ALPHA',
    name: 'Alpha Token',
    decimals: 0,
    amount: '0',
  };

  try {
    // If it's a string, try to parse as JSON
    const data = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;

    // Try to create SDK token and extract coin info using SDK methods
    try {
      const sdkToken = await SdkToken.fromJSON(data);

      // Try to get token ID
      if (sdkToken.id) {
        defaultInfo.tokenId = sdkToken.id.toJSON();
      }

      // Extract coinId from SDK token's coins structure (lottery-compatible)
      if (sdkToken.coins && sdkToken.coins.coins) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rawCoins = sdkToken.coins.coins as any[];
        if (rawCoins.length > 0) {
          const firstCoin = rawCoins[0];
          // Format: [[CoinId, amount]] or [CoinId, amount]
          let coinIdObj: unknown;
          let amount: unknown;

          if (Array.isArray(firstCoin) && firstCoin.length === 2) {
            [coinIdObj, amount] = firstCoin;
          }

          // Extract hex string from CoinId object
          if (coinIdObj instanceof CoinId) {
            const coinIdHex = coinIdObj.toJSON() as string;
            return enrichWithRegistry({
              coinId: coinIdHex,
              symbol: coinIdHex.slice(0, 8),
              name: `Token ${coinIdHex.slice(0, 8)}`,
              decimals: 0,
              amount: String(amount ?? '0'),
              tokenId: defaultInfo.tokenId,
            });
          } else if (coinIdObj && typeof coinIdObj === 'object' && 'bytes' in coinIdObj) {
            // CoinId stored as object with bytes
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const bytes = (coinIdObj as any).bytes;
            const coinIdHex = Buffer.isBuffer(bytes)
              ? bytes.toString('hex')
              : Array.isArray(bytes)
                ? Buffer.from(bytes).toString('hex')
                : String(bytes);
            return enrichWithRegistry({
              coinId: coinIdHex,
              symbol: coinIdHex.slice(0, 8),
              name: `Token ${coinIdHex.slice(0, 8)}`,
              decimals: 0,
              amount: String(amount ?? '0'),
              tokenId: defaultInfo.tokenId,
            });
          }
        }
      }

      // Fallback: Extract from JSON representation
      const tokenJson = sdkToken.toJSON() as unknown as Record<string, unknown>;
      const genesisData = tokenJson.genesis as Record<string, unknown> | undefined;
      if (genesisData?.data) {
        const gData = genesisData.data as Record<string, unknown>;
        if (gData.coinData && typeof gData.coinData === 'object') {
          // coinData might be array: [[coinIdHex, amount]]
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const coinData = gData.coinData as any;
          if (Array.isArray(coinData) && coinData.length > 0) {
            const firstEntry = coinData[0];
            if (Array.isArray(firstEntry) && firstEntry.length === 2) {
              const [coinIdHex, amount] = firstEntry;
              const coinIdStr = typeof coinIdHex === 'string' ? coinIdHex : String(coinIdHex);
              return enrichWithRegistry({
                coinId: coinIdStr,
                symbol: coinIdStr.slice(0, 8),
                name: `Token ${coinIdStr.slice(0, 8)}`,
                decimals: 0,
                amount: String(amount),
                tokenId: defaultInfo.tokenId,
              });
            }
          }
        }
      }
    } catch {
      // SDK parsing failed, try manual extraction
    }

    // Manual extraction from TXF format - handle array structure
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
    console.warn('[Payments] Failed to parse token info:', error);
  }

  return defaultInfo;
}

// =============================================================================
// Repository Utility Functions
// =============================================================================

/**
 * Extract token ID (genesis tokenId) from sdkData/jsonData
 */
function extractTokenIdFromSdkData(sdkData: string | undefined): string | null {
  if (!sdkData) return null;
  try {
    const txf = JSON.parse(sdkData);
    return txf.genesis?.data?.tokenId || null;
  } catch {
    return null;
  }
}

/**
 * Extract state hash from sdkData/jsonData
 */
function extractStateHashFromSdkData(sdkData: string | undefined): string {
  if (!sdkData) return '';
  try {
    const txf = JSON.parse(sdkData) as TxfToken;
    const stateHash = getCurrentStateHash(txf);

    // Try alternative locations if not found in standard place
    if (!stateHash) {
      if ((txf as any).state?.hash) {
        return (txf as any).state.hash;
      }
      if ((txf as any).stateHash) {
        return (txf as any).stateHash;
      }
      if ((txf as any).currentStateHash) {
        return (txf as any).currentStateHash;
      }
    }

    return stateHash || '';
  } catch {
    return '';
  }
}

/**
 * Create composite key from tokenId and stateHash
 * Format: {tokenId}_{stateHash}
 * This uniquely identifies a token at a specific state
 */
function createTokenStateKey(tokenId: string, stateHash: string): string {
  return `${tokenId}_${stateHash}`;
}

/**
 * Extract composite key (tokenId_stateHash) from token
 * Returns null if token doesn't have valid tokenId and stateHash
 */
function extractTokenStateKey(token: Token): string | null {
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
  oracle: OracleProvider;
  emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
  /** Chain code for BIP32 HD derivation (for L1 multi-address support) */
  chainCode?: string;
  /** Additional L1 addresses to watch */
  l1Addresses?: string[];
  /** Price provider (optional — enables fiat value display) */
  price?: PriceProvider;
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
  private archivedTokens: Map<string, TxfToken> = new Map();
  private forkedTokens: Map<string, TxfToken> = new Map();
  private transactionHistory: TransactionHistoryEntry[] = [];
  private nametag: NametagData | null = null;

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

  // NOSTR-FIRST proof polling (background proof verification)
  private proofPollingJobs: Map<string, ProofPollingJob> = new Map();
  private proofPollingInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly PROOF_POLLING_INTERVAL_MS = 2000;  // Poll every 2s
  private static readonly PROOF_POLLING_MAX_ATTEMPTS = 30;   // Max 30 attempts (~60s)

  // Storage event subscriptions (push-based sync)
  private storageEventUnsubscribers: (() => void)[] = [];
  private syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SYNC_DEBOUNCE_MS = 500;

  /** Sync coalescing: concurrent sync() calls share the same operation */
  private _syncInProgress: Promise<{ added: number; removed: number }> | null = null;

  constructor(config?: PaymentsModuleConfig) {
    this.moduleConfig = {
      autoSync: config?.autoSync ?? true,
      autoValidate: config?.autoValidate ?? true,
      retryFailed: config?.retryFailed ?? true,
      maxRetries: config?.maxRetries ?? 3,
      debug: config?.debug ?? false,
    };

    // Initialize L1 sub-module by default (L1PaymentsModule has default electrumUrl).
    // Only skip if l1 is explicitly set to null.
    this.l1 = config?.l1 === null ? null : new L1PaymentsModule(config?.l1);
  }

  /**
   * Get the current module configuration (excluding L1 config).
   *
   * @returns Resolved configuration with all defaults applied.
   */
  getConfig(): Omit<Required<PaymentsModuleConfig>, 'l1'> {
    return this.moduleConfig;
  }

  /** Price provider (optional) */
  private priceProvider: PriceProvider | null = null;

  private log(...args: unknown[]): void {
    if (this.moduleConfig.debug) {
      console.log('[PaymentsModule]', ...args);
    }
  }

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

    // Reset per-address state (will be re-populated by load())
    this.tokens.clear();
    this.pendingTransfers.clear();
    this.tombstones = [];
    this.archivedTokens.clear();
    this.forkedTokens.clear();
    this.transactionHistory = [];
    this.nametag = null;

    this.deps = deps;
    this.priceProvider = deps.price ?? null;

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

    // Load metadata from TokenStorageProviders (archived, tombstones, forked)
    // Active tokens are NOT stored in TXF - they are loaded from token-xxx files
    const providers = this.getTokenStorageProviders();
    for (const [id, provider] of providers) {
      try {
        const result = await provider.load();
        if (result.success && result.data) {
          this.loadFromStorageData(result.data);
          this.log(`Loaded metadata from provider ${id}`);
          break; // Use first successful provider
        }
      } catch (err) {
        console.error(`[Payments] Failed to load from provider ${id}:`, err);
      }
    }

    // Restore pending V5 tokens BEFORE file storage loading
    // (must come first because loadTokensFromFileStorage calls save() which
    // would overwrite pending V5 data if the tokens aren't in memory yet)
    await this.loadPendingV5Tokens();

    // Load active tokens from token-xxx files (primary storage for tokens)
    await this.loadTokensFromFileStorage();

    // Load nametag from file storage (nametag-{name}.json)
    // This is the primary source for nametag data now
    await this.loadNametagFromFileStorage();

    // Load transaction history
    const historyData = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY);
    if (historyData) {
      try {
        this.transactionHistory = JSON.parse(historyData);
      } catch {
        this.transactionHistory = [];
      }
    }

    // Load pending transfers
    const pending = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.PENDING_TRANSFERS);
    if (pending) {
      const transfers = JSON.parse(pending) as TransferResult[];
      for (const transfer of transfers) {
        this.pendingTransfers.set(transfer.id, transfer);
      }
    }

    // After loading, try to resolve any unconfirmed tokens
    this.resolveUnconfirmed().catch(() => {});
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

    // Stop proof polling (NOSTR-FIRST)
    this.stopProofPolling();
    this.proofPollingJobs.clear();

    // Clear pending response resolvers
    for (const [, resolver] of this.pendingResponseResolvers) {
      clearTimeout(resolver.timeout);
      resolver.reject(new Error('Module destroyed'));
    }
    this.pendingResponseResolvers.clear();

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
   */
  async send(request: TransferRequest): Promise<TransferResult> {
    this.ensureInitialized();

    // Use mutable result for building the transfer
    const result: { -readonly [K in keyof TransferResult]: TransferResult[K] } = {
      id: crypto.randomUUID(),
      status: 'pending',
      tokens: [],
      tokenTransfers: [],
    };

    try {
      // Resolve recipient once — single network query
      const peerInfo = await this.deps!.transport.resolve?.(request.recipient) ?? null;
      const recipientPubkey = this.resolveTransportPubkey(request.recipient, peerInfo);
      const recipientAddress = await this.resolveRecipientAddress(request.recipient, request.addressMode, peerInfo);

      // Create signing service
      const signingService = await this.createSigningService();

      // Get state transition client and trust base
      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      if (!stClient) {
        throw new Error('State transition client not available. Oracle provider must implement getStateTransitionClient()');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trustBase = (this.deps!.oracle as any).getTrustBase?.();
      if (!trustBase) {
        throw new Error('Trust base not available. Oracle provider must implement getTrustBase()');
      }

      // Calculate optimal split plan
      const calculator = new TokenSplitCalculator();
      const availableTokens = Array.from(this.tokens.values());
      const splitPlan = await calculator.calculateOptimalSplit(
        availableTokens,
        BigInt(request.amount),
        request.coinId
      );

      if (!splitPlan) {
        throw new Error('Insufficient balance');
      }

      // Collect all tokens involved
      const tokensToSend: Token[] = splitPlan.tokensToTransferDirectly.map(t => t.uiToken);
      if (splitPlan.tokenToSplit) {
        tokensToSend.push(splitPlan.tokenToSplit.uiToken);
      }
      result.tokens = tokensToSend;

      // Mark as transferring
      for (const token of tokensToSend) {
        token.status = 'transferring';
        this.tokens.set(token.id, token);
      }

      // Save to outbox for recovery
      await this.saveToOutbox(result, recipientPubkey);

      result.status = 'submitted';

      const recipientNametag = request.recipient.startsWith('@') ? request.recipient.slice(1) : undefined;

      const transferMode = request.transferMode ?? 'instant';

      // Handle split if required
      if (splitPlan.requiresSplit && splitPlan.tokenToSplit) {
        if (transferMode === 'conservative') {
          // Conservative split: use TokenSplitExecutor — collects all proofs before sending
          this.log('Executing conservative split...');
          const splitExecutor = new TokenSplitExecutor({
            stateTransitionClient: stClient,
            trustBase,
            signingService,
          });

          const splitResult = await splitExecutor.executeSplit(
            splitPlan.tokenToSplit.sdkToken,
            splitPlan.splitAmount!,
            splitPlan.remainderAmount!,
            splitPlan.coinId,
            recipientAddress,
          );

          // Save change token
          const changeTokenData = splitResult.tokenForSender.toJSON();
          const changeUiToken: Token = {
            id: crypto.randomUUID(),
            coinId: request.coinId,
            symbol: this.getCoinSymbol(request.coinId),
            name: this.getCoinName(request.coinId),
            decimals: this.getCoinDecimals(request.coinId),
            iconUrl: this.getCoinIconUrl(request.coinId),
            amount: splitPlan.remainderAmount!.toString(),
            status: 'confirmed',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            sdkData: JSON.stringify(changeTokenData),
          };
          await this.addToken(changeUiToken, true);
          this.log(`Conservative split: change token saved: ${changeUiToken.id}`);

          // Send fully finalized { sourceToken, transferTx } via Nostr
          await this.deps!.transport.sendTokenTransfer(recipientPubkey, {
            sourceToken: JSON.stringify(splitResult.tokenForRecipient.toJSON()),
            transferTx: JSON.stringify(splitResult.recipientTransferTx.toJSON()),
            memo: request.memo,
          } as unknown as import('../../transport').TokenTransferPayload);

          // Get request ID from the transfer commitment for tracking
          const splitCommitmentRequestId = splitResult.recipientTransferTx?.data?.requestId
            ?? splitResult.recipientTransferTx?.requestId;
          const splitRequestIdHex = splitCommitmentRequestId instanceof Uint8Array
            ? Array.from(splitCommitmentRequestId).map((b: number) => b.toString(16).padStart(2, '0')).join('')
            : splitCommitmentRequestId ? String(splitCommitmentRequestId) : undefined;

          // Remove the original token that was split — skipHistory because we record below
          await this.removeToken(splitPlan.tokenToSplit.uiToken.id, recipientNametag, true);
          result.tokenTransfers.push({
            sourceTokenId: splitPlan.tokenToSplit.uiToken.id,
            method: 'split',
            requestIdHex: splitRequestIdHex,
          });
          this.log(`Conservative split transfer completed`);
        } else {
          // Instant split: use InstantSplitExecutor for fast (~2.3s) splits
          this.log('Executing instant split...');

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const devMode = (this.deps!.oracle as any).isDevMode?.() ?? false;
          const executor = new InstantSplitExecutor({
            stateTransitionClient: stClient,
            trustBase,
            signingService,
            devMode,
          });

          const instantResult = await executor.executeSplitInstant(
            splitPlan.tokenToSplit.sdkToken,
            splitPlan.splitAmount!,
            splitPlan.remainderAmount!,
            splitPlan.coinId,
            recipientAddress,
            this.deps!.transport,
            recipientPubkey,
            {
              onChangeTokenCreated: async (changeToken) => {
                const changeTokenData = changeToken.toJSON();
                const uiToken: Token = {
                  id: crypto.randomUUID(),
                  coinId: request.coinId,
                  symbol: this.getCoinSymbol(request.coinId),
                  name: this.getCoinName(request.coinId),
                  decimals: this.getCoinDecimals(request.coinId),
                  iconUrl: this.getCoinIconUrl(request.coinId),
                  amount: splitPlan.remainderAmount!.toString(),
                  status: 'confirmed',
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                  sdkData: JSON.stringify(changeTokenData),
                };
                await this.addToken(uiToken, true);
                this.log(`Change token saved via background: ${uiToken.id}`);
              },
              onStorageSync: async () => {
                await this.save();
                return true;
              },
            }
          );

          if (!instantResult.success) {
            throw new Error(instantResult.error || 'Instant split failed');
          }

          // Track background task for change token creation
          if (instantResult.backgroundPromise) {
            this.pendingBackgroundTasks.push(instantResult.backgroundPromise);
          }

          await this.removeToken(splitPlan.tokenToSplit.uiToken.id, recipientNametag);
          result.tokenTransfers.push({
            sourceTokenId: splitPlan.tokenToSplit.uiToken.id,
            method: 'split',
            splitGroupId: instantResult.splitGroupId,
            nostrEventId: instantResult.nostrEventId,
          });
          this.log(`Instant split transfer completed`);
        }
      }

      // Transfer direct tokens (no split needed)
      for (const tokenWithAmount of splitPlan.tokensToTransferDirectly) {
        const token = tokenWithAmount.uiToken;

        // Create SDK transfer commitment
        const commitment = await this.createSdkCommitment(token, recipientAddress, signingService);

        if (transferMode === 'conservative') {
          // Conservative direct: wait for proof, then send fully finalized transfer
          console.log(`[Payments] CONSERVATIVE: Sending direct token ${token.id.slice(0, 8)}... to ${recipientPubkey.slice(0, 8)}...`);

          // Submit commitment to aggregator and wait for inclusion proof
          const submitResponse = await stClient.submitTransferCommitment(commitment);
          if (submitResponse.status !== 'SUCCESS' && submitResponse.status !== 'REQUEST_ID_EXISTS') {
            throw new Error(`Transfer commitment failed: ${submitResponse.status}`);
          }

          const inclusionProof = await waitInclusionProof(trustBase, stClient, commitment);
          const transferTx = commitment.toTransaction(inclusionProof);

          // Send fully finalized { sourceToken, transferTx } via Nostr
          await this.deps!.transport.sendTokenTransfer(recipientPubkey, {
            sourceToken: JSON.stringify(tokenWithAmount.sdkToken.toJSON()),
            transferTx: JSON.stringify(transferTx.toJSON()),
            memo: request.memo,
          } as unknown as import('../../transport').TokenTransferPayload);
          console.log(`[Payments] CONSERVATIVE: Direct token sent successfully`);
        } else {
          // Instant direct: NOSTR-FIRST - send commitment + source token via Nostr immediately
          // Submit to aggregator in background. Receiver handles via handleCommitmentOnlyTransfer().
          console.log(`[Payments] NOSTR-FIRST: Sending direct token ${token.id.slice(0, 8)}... to ${recipientPubkey.slice(0, 8)}...`);
          await this.deps!.transport.sendTokenTransfer(recipientPubkey, {
            sourceToken: JSON.stringify(tokenWithAmount.sdkToken.toJSON()),
            commitmentData: JSON.stringify(commitment.toJSON()),
            memo: request.memo,
          } as unknown as import('../../transport').TokenTransferPayload);
          console.log(`[Payments] NOSTR-FIRST: Direct token sent successfully`);

          // Submit commitment to aggregator in background (fire-and-forget)
          stClient.submitTransferCommitment(commitment).catch(err =>
            console.error('[Payments] Background commitment submit failed:', err)
          );
        }

        // Get request ID as hex string for tracking
        const requestIdBytes = commitment.requestId;
        const requestIdHex = requestIdBytes instanceof Uint8Array
          ? Array.from(requestIdBytes).map(b => b.toString(16).padStart(2, '0')).join('')
          : String(requestIdBytes);

        result.tokenTransfers.push({
          sourceTokenId: token.id,
          method: 'direct',
          requestIdHex,
        });

        this.log(`Token ${token.id} sent via ${transferMode.toUpperCase()}, requestId: ${requestIdHex}`);

        // Remove sent token (creates tombstone) — skipHistory because we record below
        await this.removeToken(token.id, recipientNametag, true);
      }

      result.status = 'delivered';

      // Save state
      await this.save();
      await this.removeFromOutbox(result.id);

      result.status = 'completed';

      // Add to transaction history
      await this.addToHistory({
        type: 'SENT',
        amount: request.amount,
        coinId: request.coinId,
        symbol: this.getCoinSymbol(request.coinId),
        timestamp: Date.now(),
        recipientNametag,
        transferId: result.id,
      });

      this.deps!.emitEvent('transfer:confirmed', result);
      return result;
    } catch (error) {
      result.status = 'failed';
      result.error = error instanceof Error ? error.message : String(error);

      // Restore tokens
      for (const token of result.tokens) {
        token.status = 'confirmed';
        this.tokens.set(token.id, token);
      }

      this.deps!.emitEvent('transfer:failed', result);
      throw error;
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

  // ===========================================================================
  // Public API - Instant Split (V5 Optimized)
  // ===========================================================================

  /**
   * Send tokens using INSTANT_SPLIT V5 optimized flow.
   *
   * This achieves ~2.3s critical path latency instead of ~42s by:
   * 1. Waiting only for burn proof (required)
   * 2. Creating transfer commitment from mint data (no mint proof needed)
   * 3. Sending bundle via Nostr immediately
   * 4. Processing mints in background
   *
   * @param request - Transfer request with recipient, amount, and coinId
   * @param options - Optional instant split configuration
   * @returns InstantSplitResult with timing info
   */
  async sendInstant(
    request: TransferRequest,
    options?: InstantSplitOptions
  ): Promise<InstantSplitResult> {
    this.ensureInitialized();

    const startTime = performance.now();

    try {
      // Resolve recipient once — single network query
      const peerInfo = await this.deps!.transport.resolve?.(request.recipient) ?? null;
      const recipientPubkey = this.resolveTransportPubkey(request.recipient, peerInfo);
      const recipientAddress = await this.resolveRecipientAddress(request.recipient, request.addressMode, peerInfo);

      // Create signing service
      const signingService = await this.createSigningService();

      // Get state transition client and trust base
      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      if (!stClient) {
        throw new Error('State transition client not available');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trustBase = (this.deps!.oracle as any).getTrustBase?.();
      if (!trustBase) {
        throw new Error('Trust base not available');
      }

      // Calculate optimal split plan
      const calculator = new TokenSplitCalculator();
      const availableTokens = Array.from(this.tokens.values());
      const splitPlan = await calculator.calculateOptimalSplit(
        availableTokens,
        BigInt(request.amount),
        request.coinId
      );

      if (!splitPlan) {
        throw new Error('Insufficient balance');
      }

      if (!splitPlan.requiresSplit || !splitPlan.tokenToSplit) {
        // For direct transfers without split, fall back to standard flow
        this.log('No split required, falling back to standard send()');
        const result = await this.send(request);
        return {
          success: result.status === 'completed',
          criticalPathDurationMs: performance.now() - startTime,
          error: result.error,
        };
      }

      this.log(`InstantSplit: amount=${splitPlan.splitAmount}, remainder=${splitPlan.remainderAmount}`);

      // Mark token as transferring
      const tokenToSplit = splitPlan.tokenToSplit.uiToken;
      tokenToSplit.status = 'transferring';
      this.tokens.set(tokenToSplit.id, tokenToSplit);

      // Check if dev mode
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const devMode = options?.devMode ?? (this.deps!.oracle as any).isDevMode?.() ?? false;

      // Create instant split executor
      const executor = new InstantSplitExecutor({
        stateTransitionClient: stClient,
        trustBase,
        signingService,
        devMode,
      });

      // Execute instant split
      const result = await executor.executeSplitInstant(
        splitPlan.tokenToSplit.sdkToken,
        splitPlan.splitAmount!,
        splitPlan.remainderAmount!,
        splitPlan.coinId,
        recipientAddress,
        this.deps!.transport,
        recipientPubkey,
        {
          ...options,
          onChangeTokenCreated: async (changeToken) => {
            // Save change token when background completes
            const changeTokenData = changeToken.toJSON();
            const uiToken: Token = {
              id: crypto.randomUUID(),
              coinId: request.coinId,
              symbol: this.getCoinSymbol(request.coinId),
              name: this.getCoinName(request.coinId),
              decimals: this.getCoinDecimals(request.coinId),
              iconUrl: this.getCoinIconUrl(request.coinId),
              amount: splitPlan.remainderAmount!.toString(),
              status: 'confirmed',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              sdkData: JSON.stringify(changeTokenData),
            };
            await this.addToken(uiToken, true);
            this.log(`Change token saved via background: ${uiToken.id}`);
          },
          onStorageSync: async () => {
            await this.save();
            return true;
          },
        }
      );

      if (result.success) {
        // Track background task for change token creation
        if (result.backgroundPromise) {
          this.pendingBackgroundTasks.push(result.backgroundPromise);
        }

        // Remove the original token — skipHistory because we record below
        const recipientNametag = request.recipient.startsWith('@') ? request.recipient.slice(1) : undefined;
        await this.removeToken(tokenToSplit.id, recipientNametag, true);

        // Add to transaction history (single entry for the actual sent amount)
        await this.addToHistory({
          type: 'SENT',
          amount: request.amount,
          coinId: request.coinId,
          symbol: this.getCoinSymbol(request.coinId),
          timestamp: Date.now(),
          recipientNametag,
        });

        await this.save();
      } else {
        // Restore token on failure
        tokenToSplit.status = 'confirmed';
        this.tokens.set(tokenToSplit.id, tokenToSplit);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        criticalPathDurationMs: performance.now() - startTime,
        error: errorMessage,
      };
    }
  }

  /**
   * Process a received INSTANT_SPLIT bundle.
   *
   * This should be called when receiving an instant split bundle via transport.
   * It handles the recipient-side processing:
   * 1. Validate burn transaction
   * 2. Submit and wait for mint proof
   * 3. Submit and wait for transfer proof
   * 4. Finalize and save the token
   *
   * @param bundle - The received InstantSplitBundle (V4 or V5)
   * @param senderPubkey - Sender's public key for verification
   * @returns Processing result with finalized token
   */
  private async processInstantSplitBundle(
    bundle: InstantSplitBundle,
    senderPubkey: string
  ): Promise<InstantSplitProcessResult> {
    this.ensureInitialized();

    if (!isInstantSplitBundleV5(bundle)) {
      // V4 (dev mode) still processes synchronously
      return this.processInstantSplitBundleSync(bundle, senderPubkey);
    }

    // V5: save immediately as unconfirmed, resolve proofs lazily
    try {
      // Use deterministic ID from splitGroupId to deduplicate Nostr re-deliveries
      const deterministicId = `v5split_${bundle.splitGroupId}`;
      if (this.tokens.has(deterministicId)) {
        this.log(`V5 bundle ${deterministicId.slice(0, 16)}... already exists, skipping duplicate`);
        return { success: true, durationMs: 0 };
      }

      const registry = TokenRegistry.getInstance();
      const pendingData: PendingV5Finalization = {
        type: 'v5_bundle',
        stage: 'RECEIVED',
        bundleJson: JSON.stringify(bundle),
        senderPubkey,
        savedAt: Date.now(),
        attemptCount: 0,
      };

      const uiToken: Token = {
        id: deterministicId,
        coinId: bundle.coinId,
        symbol: registry.getSymbol(bundle.coinId) || bundle.coinId,
        name: registry.getName(bundle.coinId) || bundle.coinId,
        decimals: registry.getDecimals(bundle.coinId) ?? 8,
        amount: bundle.amount,
        status: 'submitted',  // UNCONFIRMED
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sdkData: JSON.stringify({ _pendingFinalization: pendingData }),
      };

      await this.addToken(uiToken, false);
      this.log(`V5 bundle saved as unconfirmed: ${uiToken.id.slice(0, 8)}...`);

      // Emit incoming transfer event
      this.deps!.emitEvent('transfer:incoming', {
        id: bundle.splitGroupId,
        senderPubkey,
        tokens: [uiToken],
        receivedAt: Date.now(),
      });

      await this.save();

      // Fire-and-forget: try to resolve immediately
      this.resolveUnconfirmed().catch(() => {});

      return { success: true, durationMs: 0 };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
        durationMs: 0,
      };
    }
  }

  /**
   * Synchronous V4 bundle processing (dev mode only).
   * Kept for backward compatibility with V4 bundles.
   */
  private async processInstantSplitBundleSync(
    bundle: InstantSplitBundle,
    senderPubkey: string
  ): Promise<InstantSplitProcessResult> {
    try {
      const signingService = await this.createSigningService();

      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      if (!stClient) {
        throw new Error('State transition client not available');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trustBase = (this.deps!.oracle as any).getTrustBase?.();
      if (!trustBase) {
        throw new Error('Trust base not available');
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const devMode = (this.deps!.oracle as any).isDevMode?.() ?? false;

      const processor = new InstantSplitProcessor({
        stateTransitionClient: stClient,
        trustBase,
        devMode,
      });

      const result = await processor.processReceivedBundle(
        bundle,
        signingService,
        senderPubkey,
        {
          findNametagToken: async (proxyAddress: string) => {
            if (this.nametag?.token) {
              try {
                const nametagToken = await SdkToken.fromJSON(this.nametag.token);
                const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
                const proxy = await ProxyAddress.fromTokenId(nametagToken.id);
                if (proxy.address === proxyAddress) {
                  return nametagToken;
                }
                this.log(`Nametag PROXY address mismatch: ${proxy.address} !== ${proxyAddress}`);
                return null;
              } catch (err) {
                this.log('Failed to parse nametag token:', err);
                return null;
              }
            }
            return null;
          },
        }
      );

      if (result.success && result.token) {
        const tokenData = result.token.toJSON();
        const info = await parseTokenInfo(tokenData);

        const uiToken: Token = {
          id: crypto.randomUUID(),
          coinId: info.coinId,
          symbol: info.symbol,
          name: info.name,
          decimals: info.decimals,
          iconUrl: info.iconUrl,
          amount: bundle.amount,
          status: 'confirmed',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          sdkData: JSON.stringify(tokenData),
        };

        await this.addToken(uiToken);

        await this.addToHistory({
          type: 'RECEIVED',
          amount: bundle.amount,
          coinId: info.coinId,
          symbol: info.symbol,
          timestamp: Date.now(),
          senderPubkey,
        });

        await this.save();

        this.deps!.emitEvent('transfer:incoming', {
          id: bundle.splitGroupId,
          senderPubkey,
          tokens: [uiToken],
          receivedAt: Date.now(),
        });
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: errorMessage,
        durationMs: 0,
      };
    }
  }

  /**
   * Type-guard: check whether a payload is a valid {@link InstantSplitBundle} (V4 or V5).
   *
   * @param payload - The object to test.
   * @returns `true` if the payload matches the InstantSplitBundle shape.
   */
  private isInstantSplitBundle(payload: unknown): payload is InstantSplitBundle {
    return isInstantSplitBundle(payload);
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

      this.log(`Payment request sent: ${eventId}`);

      return {
        success: true,
        requestId,
        eventId,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log(`Failed to send payment request: ${errorMsg}`);
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
      throw new Error(`Payment request not found: ${requestId}`);
    }

    if (request.status !== 'pending' && request.status !== 'accepted') {
      throw new Error(`Payment request is not pending or accepted: ${request.status}`);
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
        this.log('Payment request handler error:', error);
      }
    }

    this.log(`Incoming payment request: ${request.id} for ${request.amount} ${request.symbol}`);
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
        this.log('Payment request response handler error:', error);
      }
    }

    this.log(`Received payment request response: ${response.id} type: ${response.responseType}`);
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
      this.log('Transport does not support sendPaymentRequestResponse');
      return;
    }

    try {
      const payload: PaymentRequestResponsePayload = {
        requestId: request.requestId, // Original request ID from sender
        responseType,
        transferId,
      };

      await this.deps.transport.sendPaymentRequestResponse(request.senderPubkey, payload);
      this.log(`Sent payment request response: ${responseType} for ${requestId}`);
    } catch (error) {
      this.log('Failed to send payment request response:', error);
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
   * When `finalize` is true, polls resolveUnconfirmed() + load() until all
   * tokens are confirmed or the timeout expires. Otherwise calls
   * resolveUnconfirmed() once to submit pending commitments.
   *
   * @param options - Optional receive options including finalization control
   * @param callback - Optional callback invoked for each newly received transfer
   * @returns ReceiveResult with transfers and finalization metadata
   */
  async receive(
    options?: ReceiveOptions,
    callback?: (transfer: IncomingTransfer) => void,
  ): Promise<ReceiveResult> {
    this.ensureInitialized();

    if (!this.deps!.transport.fetchPendingEvents) {
      throw new Error('Transport provider does not support fetchPendingEvents');
    }

    const opts = options ?? {};

    // Phase 1: Fetch pending events
    // Snapshot token keys before fetch
    const tokensBefore = new Set(this.tokens.keys());

    // Fetch and process — events flow through handleIncomingTransfer() pipeline.
    // fetchPendingEvents() collects events until EOSE, then processes sequentially
    // with await. Event dedup in the transport layer prevents double-processing
    // with the persistent subscription.
    await this.deps!.transport.fetchPendingEvents();

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

    // Phase 2: Finalization
    const result: ReceiveResult = { transfers: received };

    if (opts.finalize) {
      const timeout = opts.timeout ?? 60_000;
      const pollInterval = opts.pollInterval ?? 2_000;
      const startTime = Date.now();

      while (Date.now() - startTime < timeout) {
        const resolution = await this.resolveUnconfirmed();
        result.finalization = resolution;
        if (opts.onProgress) opts.onProgress(resolution);

        // Check if any unconfirmed tokens remain
        const stillUnconfirmed = Array.from(this.tokens.values()).some(
          t => t.status === 'submitted' || t.status === 'pending'
        );
        if (!stillUnconfirmed) break;

        await new Promise(r => setTimeout(r, pollInterval));
        await this.load();
      }

      result.finalizationDurationMs = Date.now() - startTime;
      result.timedOut = Array.from(this.tokens.values()).some(
        t => t.status === 'submitted' || t.status === 'pending'
      );
    } else {
      // Non-finalize: submit commitments once (fire-and-forget style)
      result.finalization = await this.resolveUnconfirmed();
    }

    return result;
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
    if (this.pendingBackgroundTasks.length > 0) {
      await Promise.allSettled(this.pendingBackgroundTasks);
      this.pendingBackgroundTasks = [];
    }
  }

  /**
   * Get total portfolio value in USD.
   * Returns null if PriceProvider is not configured.
   */
  async getFiatBalance(): Promise<number | null> {
    const assets = await this.getAssets();

    if (!this.priceProvider) {
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
    if (!this.priceProvider || rawAssets.length === 0) {
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
      console.warn('[Payments] Failed to fetch prices, returning assets without price data:', error);
    }

    return rawAssets;
  }

  /**
   * Aggregate tokens by coinId with confirmed/unconfirmed breakdown.
   * Excludes tokens with status 'spent', 'invalid', or 'transferring'.
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
    }>();

    for (const token of this.tokens.values()) {
      // Skip spent, invalid, and transferring tokens
      if (token.status === 'spent' || token.status === 'invalid' || token.status === 'transferring') continue;
      if (coinId && token.coinId !== coinId) continue;

      const key = token.coinId;
      const amount = BigInt(token.amount);
      const isConfirmed = token.status === 'confirmed';
      const existing = assetsMap.get(key);

      if (existing) {
        if (isConfirmed) {
          existing.confirmedAmount += amount;
          existing.confirmedTokenCount++;
        } else {
          existing.unconfirmedAmount += amount;
          existing.unconfirmedTokenCount++;
        }
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
    return this.tokens.get(id);
  }

  // ===========================================================================
  // Public API - Unconfirmed Token Resolution
  // ===========================================================================

  /**
   * Attempt to resolve unconfirmed (status `'submitted'`) tokens by acquiring
   * their missing aggregator proofs.
   *
   * Each unconfirmed V5 token progresses through stages:
   * `RECEIVED` → `MINT_SUBMITTED` → `MINT_PROVEN` → `TRANSFER_SUBMITTED` → `FINALIZED`
   *
   * Uses 500 ms quick-timeouts per proof check so the call returns quickly even
   * when proofs are not yet available. Tokens that exceed 50 failed attempts are
   * marked `'invalid'`.
   *
   * Automatically called (fire-and-forget) by {@link load}.
   *
   * @returns Summary with counts of resolved, still-pending, and failed tokens plus per-token details.
   */
  async resolveUnconfirmed(): Promise<UnconfirmedResolutionResult> {
    this.ensureInitialized();
    const result: UnconfirmedResolutionResult = {
      resolved: 0,
      stillPending: 0,
      failed: 0,
      details: [],
    };

    const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trustBase = (this.deps!.oracle as any).getTrustBase?.() as RootTrustBase | undefined;
    if (!stClient || !trustBase) return result;

    const signingService = await this.createSigningService();

    for (const [tokenId, token] of this.tokens) {
      if (token.status !== 'submitted') continue;

      // Check for pending finalization metadata
      const pending = this.parsePendingFinalization(token.sdkData);
      if (!pending) {
        // Legacy commitment-only token (existing proof polling handles these)
        result.stillPending++;
        continue;
      }

      if (pending.type === 'v5_bundle') {
        const progress = await this.resolveV5Token(tokenId, token, pending, stClient, trustBase, signingService);
        result.details.push({ tokenId, stage: pending.stage, status: progress });
        if (progress === 'resolved') result.resolved++;
        else if (progress === 'failed') result.failed++;
        else result.stillPending++;
      }
    }

    if (result.resolved > 0 || result.failed > 0) {
      await this.save();
    }
    return result;
  }

  // ===========================================================================
  // Private - V5 Lazy Resolution Helpers
  // ===========================================================================

  /**
   * Process a single V5 token through its finalization stages with quick-timeout proof checks.
   */
  private async resolveV5Token(
    tokenId: string,
    token: Token,
    pending: PendingV5Finalization,
    stClient: StateTransitionClient,
    trustBase: RootTrustBase,
    signingService: SigningService
  ): Promise<'resolved' | 'pending' | 'failed'> {
    const bundle: InstantSplitBundleV5 = JSON.parse(pending.bundleJson);
    pending.attemptCount++;
    pending.lastAttemptAt = Date.now();

    try {
      // Stage: RECEIVED → MINT_SUBMITTED
      if (pending.stage === 'RECEIVED') {
        const mintDataJson = JSON.parse(bundle.recipientMintData);
        const mintData = await MintTransactionData.fromJSON(mintDataJson);
        const mintCommitment = await MintCommitment.create(mintData);
        const mintResponse = await stClient.submitMintCommitment(mintCommitment);
        if (mintResponse.status !== 'SUCCESS' && mintResponse.status !== 'REQUEST_ID_EXISTS') {
          throw new Error(`Mint submission failed: ${mintResponse.status}`);
        }
        pending.stage = 'MINT_SUBMITTED';
        this.updatePendingFinalization(token, pending);
      }

      // Stage: MINT_SUBMITTED → MINT_PROVEN
      if (pending.stage === 'MINT_SUBMITTED') {
        const mintDataJson = JSON.parse(bundle.recipientMintData);
        const mintData = await MintTransactionData.fromJSON(mintDataJson);
        const mintCommitment = await MintCommitment.create(mintData);
        const proof = await this.quickProofCheck(stClient, trustBase, mintCommitment);
        if (!proof) {
          this.updatePendingFinalization(token, pending);
          return 'pending';
        }
        pending.mintProofJson = JSON.stringify(proof);
        pending.stage = 'MINT_PROVEN';
        this.updatePendingFinalization(token, pending);
      }

      // Stage: MINT_PROVEN → TRANSFER_SUBMITTED
      if (pending.stage === 'MINT_PROVEN') {
        const transferCommitmentJson = JSON.parse(bundle.transferCommitment);
        const transferCommitment = await TransferCommitment.fromJSON(transferCommitmentJson);
        const transferResponse = await stClient.submitTransferCommitment(transferCommitment);
        if (transferResponse.status !== 'SUCCESS' && transferResponse.status !== 'REQUEST_ID_EXISTS') {
          throw new Error(`Transfer submission failed: ${transferResponse.status}`);
        }
        pending.stage = 'TRANSFER_SUBMITTED';
        this.updatePendingFinalization(token, pending);
      }

      // Stage: TRANSFER_SUBMITTED → FINALIZED
      if (pending.stage === 'TRANSFER_SUBMITTED') {
        const transferCommitmentJson = JSON.parse(bundle.transferCommitment);
        const transferCommitment = await TransferCommitment.fromJSON(transferCommitmentJson);
        const proof = await this.quickProofCheck(stClient, trustBase, transferCommitment);
        if (!proof) {
          this.updatePendingFinalization(token, pending);
          return 'pending';
        }

        // Finalize: reconstruct minted token, create recipient state, finalize
        const finalizedToken = await this.finalizeFromV5Bundle(bundle, pending, signingService, stClient, trustBase);

        // Replace token with confirmed version containing real SDK data
        const confirmedToken: Token = {
          id: token.id,
          coinId: token.coinId,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          iconUrl: token.iconUrl,
          amount: token.amount,
          status: 'confirmed',
          createdAt: token.createdAt,
          updatedAt: Date.now(),
          sdkData: JSON.stringify(finalizedToken.toJSON()),
        };
        this.tokens.set(tokenId, confirmedToken);

        // Update individual file
        await this.saveTokenToFileStorage(confirmedToken);

        // Add to history
        await this.addToHistory({
          type: 'RECEIVED',
          amount: confirmedToken.amount,
          coinId: confirmedToken.coinId,
          symbol: confirmedToken.symbol || 'UNK',
          timestamp: Date.now(),
          senderPubkey: pending.senderPubkey,
        });

        this.log(`V5 token resolved: ${tokenId.slice(0, 8)}...`);
        return 'resolved';
      }

      return 'pending';
    } catch (error) {
      console.error(`[Payments] resolveV5Token failed for ${tokenId.slice(0, 8)}:`, error);
      if (pending.attemptCount > 50) {
        token.status = 'invalid';
        token.updatedAt = Date.now();
        this.tokens.set(tokenId, token);
        return 'failed';
      }
      this.updatePendingFinalization(token, pending);
      return 'pending';
    }
  }

  /**
   * Non-blocking proof check with 500ms timeout.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async quickProofCheck(
    stClient: StateTransitionClient,
    trustBase: RootTrustBase,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commitment: any,
    timeoutMs: number = 500
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any | null> {
    try {
      const proof = await Promise.race([
        waitInclusionProof(trustBase, stClient, commitment),
        new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      return proof;
    } catch {
      return null;
    }
  }

  /**
   * Perform V5 bundle finalization from stored bundle data and proofs.
   * Extracted from InstantSplitProcessor.processV5Bundle() steps 4-10.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async finalizeFromV5Bundle(
    bundle: InstantSplitBundleV5,
    pending: PendingV5Finalization,
    signingService: SigningService,
    stClient: StateTransitionClient,
    trustBase: RootTrustBase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<SdkToken<any>> {
    // Reconstruct minted token from bundle data
    const mintDataJson = JSON.parse(bundle.recipientMintData);
    const mintData = await MintTransactionData.fromJSON(mintDataJson);
    const mintCommitment = await MintCommitment.create(mintData);
    const mintProofJson = JSON.parse(pending.mintProofJson!);
    const mintProof = InclusionProof.fromJSON(mintProofJson);
    const mintTransaction = mintCommitment.toTransaction(mintProof);

    const tokenType = new TokenType(fromHex(bundle.tokenTypeHex));
    const senderMintedStateJson = JSON.parse(bundle.mintedTokenStateJson);

    const tokenJson = {
      version: '2.0',
      state: senderMintedStateJson,
      genesis: mintTransaction.toJSON(),
      transactions: [],
      nametags: [],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mintedToken = await SdkToken.fromJSON(tokenJson) as SdkToken<any>;

    // Create transfer transaction
    const transferCommitmentJson = JSON.parse(bundle.transferCommitment);
    const transferCommitment = await TransferCommitment.fromJSON(transferCommitmentJson);
    const transferProof = await waitInclusionProof(trustBase, stClient, transferCommitment);
    const transferTransaction = transferCommitment.toTransaction(transferProof);

    // Create recipient state
    const transferSalt = fromHex(bundle.transferSaltHex);
    const recipientPredicate = await UnmaskedPredicate.create(
      mintData.tokenId,
      tokenType,
      signingService,
      HashAlgorithm.SHA256,
      transferSalt
    );
    const recipientState = new TokenState(recipientPredicate, null);

    // Handle nametag tokens for PROXY addresses
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let nametagTokens: SdkToken<any>[] = [];
    const recipientAddressStr = bundle.recipientAddressJson;

    if (recipientAddressStr.startsWith('PROXY://')) {
      // Try to get nametag token from bundle first
      if (bundle.nametagTokenJson) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nametagToken = await SdkToken.fromJSON(JSON.parse(bundle.nametagTokenJson)) as SdkToken<any>;
          const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
          const proxy = await ProxyAddress.fromTokenId(nametagToken.id);
          if (proxy.address === recipientAddressStr) {
            nametagTokens = [nametagToken];
          }
        } catch {
          // Fall through to local nametag lookup
        }
      }

      // If not in bundle, try local nametag
      if (nametagTokens.length === 0 && this.nametag?.token) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nametagToken = await SdkToken.fromJSON(this.nametag.token) as SdkToken<any>;
          const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
          const proxy = await ProxyAddress.fromTokenId(nametagToken.id);
          if (proxy.address === recipientAddressStr) {
            nametagTokens = [nametagToken];
          }
        } catch {
          // No nametag available
        }
      }
    }

    // Finalize
    return stClient.finalizeTransaction(trustBase, mintedToken, recipientState, transferTransaction, nametagTokens);
  }

  /**
   * Parse pending finalization metadata from token's sdkData.
   */
  private parsePendingFinalization(sdkData: string | undefined): PendingV5Finalization | null {
    if (!sdkData) return null;
    try {
      const data = JSON.parse(sdkData);
      if (data._pendingFinalization && data._pendingFinalization.type === 'v5_bundle') {
        return data._pendingFinalization as PendingV5Finalization;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Update pending finalization metadata in token's sdkData.
   * Creates a new token object since sdkData is readonly.
   */
  private updatePendingFinalization(token: Token, pending: PendingV5Finalization): void {
    const updated: Token = {
      id: token.id,
      coinId: token.coinId,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      iconUrl: token.iconUrl,
      amount: token.amount,
      status: token.status,
      createdAt: token.createdAt,
      updatedAt: Date.now(),
      sdkData: JSON.stringify({ _pendingFinalization: pending }),
    };
    this.tokens.set(token.id, updated);
  }

  /**
   * Save pending V5 tokens to key-value storage.
   * These tokens can't be serialized to TXF format (no genesis/state),
   * so we persist them separately and restore on load().
   */
  private async savePendingV5Tokens(): Promise<void> {
    const pendingTokens: Token[] = [];
    for (const token of this.tokens.values()) {
      if (this.parsePendingFinalization(token.sdkData)) {
        pendingTokens.push(token);
      }
    }
    if (pendingTokens.length > 0) {
      await this.deps!.storage.set(
        STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS,
        JSON.stringify(pendingTokens)
      );
    } else {
      // Clean up when no pending tokens remain
      await this.deps!.storage.set(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS, '');
    }
  }

  /**
   * Load pending V5 tokens from key-value storage and merge into tokens map.
   * Called during load() to restore tokens that TXF format can't represent.
   */
  private async loadPendingV5Tokens(): Promise<void> {
    const data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS);
    if (!data) return;

    try {
      const pendingTokens = JSON.parse(data) as Token[];
      for (const token of pendingTokens) {
        // Only restore if not already in the map (e.g., already resolved)
        if (!this.tokens.has(token.id)) {
          this.tokens.set(token.id, token);
        }
      }
      if (pendingTokens.length > 0) {
        this.log(`Restored ${pendingTokens.length} pending V5 token(s)`);
      }
    } catch {
      // Ignore corrupt data
    }
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
   * @param skipHistory - When `true`, do not create a `RECEIVED` transaction history entry (default `false`).
   * @returns `true` if the token was added, `false` if rejected as duplicate or tombstoned.
   */
  async addToken(token: Token, skipHistory: boolean = false): Promise<boolean> {
    this.ensureInitialized();

    const incomingTokenId = extractTokenIdFromSdkData(token.sdkData);
    const incomingStateHash = extractStateHashFromSdkData(token.sdkData);
    const incomingStateKey = incomingTokenId && incomingStateHash
      ? createTokenStateKey(incomingTokenId, incomingStateHash)
      : null;

    // Check tombstones - reject tokens with exact (tokenId, stateHash) match
    // This prevents spent tokens from being re-added via Nostr re-delivery
    // Tokens with the same tokenId but DIFFERENT stateHash are allowed (new state)
    if (incomingTokenId && incomingStateHash && this.isStateTombstoned(incomingTokenId, incomingStateHash)) {
      this.log(`Rejecting tombstoned token: ${incomingTokenId.slice(0, 8)}..._${incomingStateHash.slice(0, 8)}...`);
      return false;
    }

    // Check for exact duplicate (same tokenId AND same stateHash)
    if (incomingStateKey) {
      for (const [existingId, existing] of this.tokens) {
        if (isSameTokenState(existing, token)) {
          // Exact duplicate - same tokenId and same stateHash
          this.log(`Duplicate token state ignored: ${incomingTokenId?.slice(0, 8)}..._${incomingStateHash?.slice(0, 8)}...`);
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
          this.log(`Replacing spent/invalid token ${incomingTokenId?.slice(0, 8)}...`);
          this.tokens.delete(existingId);
          break;
        }

        // CASE 2: Different stateHash - this is a newer state of the token
        // Remove old state (it will be archived) and add new state
        if (incomingStateHash && existingStateHash && incomingStateHash !== existingStateHash) {
          this.log(`Token ${incomingTokenId?.slice(0, 8)}... state updated: ${existingStateHash.slice(0, 8)}... -> ${incomingStateHash.slice(0, 8)}...`);
          // Archive old state before removing
          await this.archiveToken(existing);
          this.tokens.delete(existingId);
          break;
        }

        // CASE 3: No state hashes available - use .id as heuristic
        if (!incomingStateHash || !existingStateHash) {
          if (existingId !== token.id) {
            this.log(`Token ${incomingTokenId?.slice(0, 8)}... .id changed, replacing`);
            await this.archiveToken(existing);
            this.tokens.delete(existingId);
            break;
          }
        }
      }
    }

    // Add the new token state
    this.tokens.set(token.id, token);

    // Archive the token (for recovery purposes)
    await this.archiveToken(token);

    // Add to transaction history
    if (!skipHistory && token.coinId && token.amount) {
      await this.addToHistory({
        type: 'RECEIVED',
        amount: token.amount,
        coinId: token.coinId,
        symbol: token.symbol || 'UNK',
        timestamp: token.createdAt || Date.now(),
      });
    }

    await this.save();

    // Save as individual token file (like lottery pattern)
    // Skip for pending V5 tokens - they don't have valid SDK data for the legacy format
    // and would be corrupted by parseTokenInfo() on reload
    if (!this.parsePendingFinalization(token.sdkData)) {
      await this.saveTokenToFileStorage(token);
    }

    this.log(`Added token ${token.id}, total: ${this.tokens.size}`);
    return true;
  }

  /**
   * Save token as individual file to token storage providers
   * Similar to lottery's saveReceivedToken() pattern
   */
  private async saveTokenToFileStorage(token: Token): Promise<void> {
    const providers = this.getTokenStorageProviders();
    if (providers.size === 0) return;

    // Extract SDK token ID for filename
    const sdkTokenId = extractTokenIdFromSdkData(token.sdkData);
    const tokenIdPrefix = sdkTokenId ? sdkTokenId.slice(0, 16) : token.id.slice(0, 16);
    const filename = `token-${tokenIdPrefix}-${Date.now()}`;

    // Token data to save (similar to lottery format)
    const tokenData = {
      token: token.sdkData ? JSON.parse(token.sdkData) : null,
      receivedAt: Date.now(),
      meta: {
        id: token.id,
        coinId: token.coinId,
        symbol: token.symbol,
        amount: token.amount,
        status: token.status,
      },
    };

    // Save to all token storage providers
    for (const [providerId, provider] of providers) {
      try {
        if (provider.saveToken) {
          await provider.saveToken(filename, tokenData);
          this.log(`Saved token file ${filename} to ${providerId}`);
        }
      } catch (error) {
        console.warn(`[Payments] Failed to save token to ${providerId}:`, error);
      }
    }
  }

  /**
   * Load tokens from file storage providers (lottery compatibility)
   * This loads tokens from file-based storage that may have been saved
   * by other applications using the same storage directory.
   */
  private async loadTokensFromFileStorage(): Promise<void> {
    const providers = this.getTokenStorageProviders();
    if (providers.size === 0) return;

    for (const [providerId, provider] of providers) {
      if (!provider.listTokenIds || !provider.getToken) continue;

      try {
        const allIds = await provider.listTokenIds();
        // Only load token-xxx entries (not archived-, nametag-, or raw hex IDs)
        const tokenIds = allIds.filter(id => id.startsWith('token-'));
        this.log(`Found ${tokenIds.length} token files in ${providerId}`);

        for (const tokenId of tokenIds) {
          try {
            const fileData = await provider.getToken(tokenId);
            if (!fileData || typeof fileData !== 'object') continue;

            // Handle lottery format: { token, receivedAt } or { token, receivedAt, meta }
            const data = fileData as Record<string, unknown>;
            const tokenJson = data.token;
            if (!tokenJson) continue;

            // Skip pending V5 finalization tokens (not valid SDK token data)
            if (typeof tokenJson === 'object' && tokenJson !== null && '_pendingFinalization' in (tokenJson as Record<string, unknown>)) {
              continue;
            }

            // Check if already loaded from key-value storage
            let sdkTokenId: string | undefined;
            if (typeof tokenJson === 'object' && tokenJson !== null) {
              const tokenObj = tokenJson as Record<string, unknown>;
              const genesis = tokenObj.genesis as Record<string, unknown> | undefined;
              const genesisData = genesis?.data as Record<string, unknown> | undefined;
              sdkTokenId = genesisData?.tokenId as string | undefined;
            }

            if (sdkTokenId) {
              // Check if this token already exists
              let exists = false;
              for (const existing of this.tokens.values()) {
                const existingId = extractTokenIdFromSdkData(existing.sdkData);
                if (existingId === sdkTokenId) {
                  exists = true;
                  break;
                }
              }
              if (exists) continue;
            }

            // Parse token info
            const tokenInfo = await parseTokenInfo(tokenJson);

            // Create token entry
            const token: Token = {
              id: tokenInfo.tokenId ?? tokenId,
              coinId: tokenInfo.coinId,
              symbol: tokenInfo.symbol,
              name: tokenInfo.name,
              decimals: tokenInfo.decimals,
              iconUrl: tokenInfo.iconUrl,
              amount: tokenInfo.amount,
              status: 'confirmed',
              createdAt: (data.receivedAt as number) || Date.now(),
              updatedAt: Date.now(),
              sdkData: typeof tokenJson === 'string'
                ? tokenJson
                : JSON.stringify(tokenJson),
            };

            // Check if this token is tombstoned (was previously removed/sent)
            const loadedTokenId = extractTokenIdFromSdkData(token.sdkData);
            const loadedStateHash = extractStateHashFromSdkData(token.sdkData);
            if (loadedTokenId && loadedStateHash && this.isStateTombstoned(loadedTokenId, loadedStateHash)) {
              this.log(`Skipping tombstoned token file ${tokenId} (${loadedTokenId.slice(0, 8)}...)`);
              continue;
            }

            // Add to in-memory storage (skip file save since it's already in file)
            this.tokens.set(token.id, token);
            this.log(`Loaded token from file: ${tokenId}`);
          } catch (tokenError) {
            console.warn(`[Payments] Failed to load token ${tokenId}:`, tokenError);
          }
        }
      } catch (error) {
        console.warn(`[Payments] Failed to load tokens from ${providerId}:`, error);
      }
    }

    this.log(`Loaded ${this.tokens.size} tokens from file storage`);
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
    for (const [id, existing] of this.tokens) {
      const existingTokenId = extractTokenIdFromSdkData(existing.sdkData);
      if ((existingTokenId && incomingTokenId && existingTokenId === incomingTokenId) ||
          existing.id === token.id) {
        this.tokens.delete(id);
        this.tokens.set(token.id, token);
        found = true;
        break;
      }
    }

    if (!found) {
      await this.addToken(token, true);
      return;
    }

    // Archive the updated token
    await this.archiveToken(token);

    await this.save();
    this.log(`Updated token ${token.id}`);
  }

  /**
   * Remove a token from the wallet.
   *
   * The token is archived first, then a tombstone `(tokenId, stateHash)` is
   * created to prevent re-addition via Nostr re-delivery. A `SENT` history
   * entry is created unless `skipHistory` is `true`.
   *
   * @param tokenId - Local UUID of the token to remove.
   * @param recipientNametag - Optional nametag of the transfer recipient (for history).
   * @param skipHistory - When `true`, skip creating a transaction history entry (default `false`).
   */
  async removeToken(tokenId: string, recipientNametag?: string, skipHistory: boolean = false): Promise<void> {
    this.ensureInitialized();

    const token = this.tokens.get(tokenId);
    if (!token) return;

    // Archive before removing
    await this.archiveToken(token);

    // Create tombstone with exact (tokenId, stateHash) - requires both
    const tombstone = createTombstoneFromToken(token);
    if (tombstone) {
      const alreadyTombstoned = this.tombstones.some(
        t => t.tokenId === tombstone.tokenId && t.stateHash === tombstone.stateHash
      );
      if (!alreadyTombstoned) {
        this.tombstones.push(tombstone);
        this.log(`Created tombstone for ${tombstone.tokenId.slice(0, 8)}..._${tombstone.stateHash.slice(0, 8)}...`);
      }
    } else {
      // No valid tombstone could be created (missing tokenId or stateHash)
      // Token will still be removed but may be re-synced later
      this.log(`Warning: Could not create tombstone for token ${tokenId.slice(0, 8)}... (missing tokenId or stateHash)`);
    }

    // Remove from active tokens
    this.tokens.delete(tokenId);

    // Delete physical token file(s) from storage providers
    await this.deleteTokenFiles(token);

    // Add to transaction history
    if (!skipHistory && token.coinId && token.amount) {
      await this.addToHistory({
        type: 'SENT',
        amount: token.amount,
        coinId: token.coinId,
        symbol: token.symbol || 'UNK',
        timestamp: Date.now(),
        recipientNametag,
      });
    }

    await this.save();
  }

  /**
   * Delete physical token file(s) from all storage providers.
   * Finds files by matching the SDK token ID prefix in the filename.
   */
  private async deleteTokenFiles(token: Token): Promise<void> {
    const sdkTokenId = extractTokenIdFromSdkData(token.sdkData);
    if (!sdkTokenId) return;

    const tokenIdPrefix = sdkTokenId.slice(0, 16);
    const providers = this.getTokenStorageProviders();

    for (const [providerId, provider] of providers) {
      if (!provider.listTokenIds || !provider.deleteToken) continue;
      try {
        const allIds = await provider.listTokenIds();
        const matchingFiles = allIds.filter(id =>
          id.startsWith(`token-${tokenIdPrefix}`)
        );
        for (const fileId of matchingFiles) {
          await provider.deleteToken(fileId);
          this.log(`Deleted token file ${fileId} from ${providerId}`);
        }
      } catch (error) {
        console.warn(`[Payments] Failed to delete token files from ${providerId}:`, error);
      }
    }
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
   *
   * @param tokenId - The genesis token ID.
   * @param stateHash - The state hash of the token version to check.
   * @returns `true` if the exact combination has been tombstoned.
   */
  isStateTombstoned(tokenId: string, stateHash: string): boolean {
    return this.tombstones.some(
      t => t.tokenId === tokenId && t.stateHash === stateHash
    );
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
      this.log(`Removed tombstoned token ${token.id.slice(0, 8)}...`);
      removedCount++;
    }

    // Merge tombstones (union)
    for (const remoteTombstone of remoteTombstones) {
      const alreadyExists = this.tombstones.some(
        t => t.tokenId === remoteTombstone.tokenId && t.stateHash === remoteTombstone.stateHash
      );
      if (!alreadyExists) {
        this.tombstones.push(remoteTombstone);
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

    if (this.tombstones.length < originalCount) {
      await this.save();
      this.log(`Pruned tombstones from ${originalCount} to ${this.tombstones.length}`);
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
    this.log(`Pruned archived tokens from ${originalCount} to ${this.archivedTokens.size}`);
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
    this.log(`Stored forked token ${tokenId.slice(0, 8)}... state ${stateHash.slice(0, 12)}...`);
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
    this.log(`Pruned forked tokens from ${originalCount} to ${this.forkedTokens.size}`);
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
    return [...this.transactionHistory].sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Append an entry to the transaction history.
   *
   * A unique `id` is auto-generated. The entry is immediately persisted to storage.
   *
   * @param entry - History entry fields (without `id`).
   */
  async addToHistory(entry: Omit<TransactionHistoryEntry, 'id'>): Promise<void> {
    this.ensureInitialized();

    const historyEntry: TransactionHistoryEntry = {
      id: crypto.randomUUID(),
      ...entry,
    };
    this.transactionHistory.push(historyEntry);

    await this.deps!.storage.set(
      STORAGE_KEYS_ADDRESS.TRANSACTION_HISTORY,
      JSON.stringify(this.transactionHistory)
    );
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
    this.nametag = nametag;
    await this.save();
    // Save to file storage for lottery compatibility
    await this.saveNametagToFileStorage(nametag);
    this.log(`Nametag set: ${nametag.name}`);
  }

  /**
   * Get the current nametag data.
   *
   * @returns The nametag data, or `null` if no nametag is set.
   */
  getNametag(): NametagData | null {
    return this.nametag;
  }

  /**
   * Check whether a nametag is currently set.
   *
   * @returns `true` if nametag data is present.
   */
  hasNametag(): boolean {
    return this.nametag !== null;
  }

  /**
   * Remove the current nametag data from memory and storage.
   */
  async clearNametag(): Promise<void> {
    this.ensureInitialized();
    this.nametag = null;
    await this.save();
  }

  /**
   * Save nametag to file storage for lottery compatibility
   * Creates file: nametag-{name}.json
   */
  private async saveNametagToFileStorage(nametag: NametagData): Promise<void> {
    const providers = this.getTokenStorageProviders();
    if (providers.size === 0) return;

    const filename = `nametag-${nametag.name}`;

    // Lottery-compatible format
    const fileData = {
      nametag: nametag.name,
      token: nametag.token,
      timestamp: nametag.timestamp || Date.now(),
    };

    for (const [providerId, provider] of providers) {
      try {
        if (provider.saveToken) {
          await provider.saveToken(filename, fileData);
          this.log(`Saved nametag file ${filename} to ${providerId}`);
        }
      } catch (error) {
        console.warn(`[Payments] Failed to save nametag to ${providerId}:`, error);
      }
    }
  }

  /**
   * Load nametag from file storage (lottery compatibility)
   * Looks for file: nametag-{name}.json
   */
  private async loadNametagFromFileStorage(): Promise<void> {
    if (this.nametag) return; // Already loaded from key-value storage

    const providers = this.getTokenStorageProviders();
    if (providers.size === 0) return;

    for (const [providerId, provider] of providers) {
      if (!provider.listTokenIds || !provider.getToken) continue;

      try {
        const tokenIds = await provider.listTokenIds();
        const nametagFiles = tokenIds.filter(id => id.startsWith('nametag-'));

        for (const nametagFile of nametagFiles) {
          try {
            const fileData = await provider.getToken(nametagFile);
            if (!fileData || typeof fileData !== 'object') continue;

            const data = fileData as Record<string, unknown>;
            if (!data.token || !data.nametag) continue;

            // Convert to NametagData format
            this.nametag = {
              name: data.nametag as string,
              token: data.token as object,
              timestamp: (data.timestamp as number) || Date.now(),
              format: 'lottery',
              version: '1.0',
            };

            this.log(`Loaded nametag from file: ${nametagFile}`);
            return; // Found one, stop searching
          } catch (fileError) {
            console.warn(`[Payments] Failed to load nametag file ${nametagFile}:`, fileError);
          }
        }
      } catch (error) {
        console.warn(`[Payments] Failed to search nametag files in ${providerId}:`, error);
      }
    }
  }

  /**
   * Mint a nametag token on-chain (like Sphere wallet and lottery)
   * This creates the nametag token required for receiving tokens via PROXY addresses
   *
   * @param nametag - The nametag to mint (e.g., "alice" or "@alice")
   * @returns MintNametagResult with success status and token if successful
   */
  async mintNametag(nametag: string): Promise<MintNametagResult> {
    this.ensureInitialized();

    // Get state transition client and trust base
    const stClient = this.deps!.oracle.getStateTransitionClient?.();
    if (!stClient) {
      return {
        success: false,
        error: 'State transition client not available. Oracle provider must implement getStateTransitionClient()',
      };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trustBase = (this.deps!.oracle as any).getTrustBase?.();
    if (!trustBase) {
      return {
        success: false,
        error: 'Trust base not available. Oracle provider must implement getTrustBase()',
      };
    }

    try {
      // Create signing service
      const signingService = await this.createSigningService();

      // Create owner address using UnmaskedPredicateReference (same pattern as TokenSplitExecutor)
      const { UnmaskedPredicateReference } = await import('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference');
      const { TokenType } = await import('@unicitylabs/state-transition-sdk/lib/token/TokenType');

      // Use a dummy token type for address creation (like Sphere wallet does)
      const UNICITY_TOKEN_TYPE_HEX = 'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';
      const tokenType = new TokenType(Buffer.from(UNICITY_TOKEN_TYPE_HEX, 'hex'));

      const addressRef = await UnmaskedPredicateReference.create(
        tokenType,
        signingService.algorithm,
        signingService.publicKey,
        HashAlgorithm.SHA256
      );
      const ownerAddress = await addressRef.toAddress();

      // Create NametagMinter
      const minter = new NametagMinter({
        stateTransitionClient: stClient,
        trustBase,
        signingService,
        debug: this.moduleConfig.debug,
      });

      // Mint the nametag
      const result = await minter.mintNametag(nametag, ownerAddress);

      if (result.success && result.nametagData) {
        // Save the nametag data
        await this.setNametag(result.nametagData);
        this.log(`Nametag minted and saved: ${result.nametagData.name}`);

        // Emit event (use existing nametag:registered event type)
        this.deps!.emitEvent('nametag:registered', {
          nametag: result.nametagData.name,
          addressIndex: 0, // Primary address
        });
      }

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.log('mintNametag failed:', errorMsg);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Check if a nametag is available for minting
   * @param nametag - The nametag to check (e.g., "alice" or "@alice")
   */
  async isNametagAvailable(nametag: string): Promise<boolean> {
    this.ensureInitialized();

    const stClient = this.deps!.oracle.getStateTransitionClient?.();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trustBase = (this.deps!.oracle as any).getTrustBase?.();

    if (!stClient || !trustBase) {
      return false;
    }

    try {
      const signingService = await this.createSigningService();
      const minter = new NametagMinter({
        stateTransitionClient: stClient,
        trustBase,
        signingService,
      });

      return await minter.isNametagAvailable(nametag);
    } catch {
      return false;
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

      // Sync with each provider
      for (const [providerId, provider] of providers) {
        try {
          const result = await provider.sync(localData);

          if (result.success && result.merged) {
            // Apply merged data from each provider
            this.loadFromStorageData(result.merged);
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
          console.warn(`[PaymentsModule] Sync failed for provider ${providerId}:`, providerError);
          this.deps!.emitEvent('sync:provider', {
            providerId,
            success: false,
            error: providerError instanceof Error ? providerError.message : String(providerError),
          });
        }
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
            this.log('Remote update detected from provider', providerId, event.data);
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
          this.log('Auto-sync from remote update failed:', err);
        });
    }, PaymentsModule.SYNC_DEBOUNCE_MS);
  }

  /**
   * Get all active token storage providers
   */
  private getTokenStorageProviders(): Map<string, TokenStorageProvider<TxfStorageDataBase>> {
    // Prefer new multi-provider map
    if (this.deps!.tokenStorageProviders && this.deps!.tokenStorageProviders.size > 0) {
      return this.deps!.tokenStorageProviders;
    }

    // Fallback to deprecated single provider
    if (this.deps!.tokenStorage) {
      const map = new Map<string, TokenStorageProvider<TxfStorageDataBase>>();
      map.set(this.deps!.tokenStorage.id, this.deps!.tokenStorage);
      return map;
    }

    return new Map();
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

    for (const token of this.tokens.values()) {
      const result = await this.deps!.oracle.validateToken(token.sdkData);

      if (result.valid && !result.spent) {
        valid.push(token);
      } else {
        token.status = 'invalid';
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
    // If we have PeerInfo, use it
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

    throw new Error(
      `Cannot resolve transport pubkey for "${recipient}". ` +
      `No binding event found. The recipient must publish their identity first.`
    );
  }

  /**
   * Create SDK TransferCommitment for a token transfer
   */
  private async createSdkCommitment(
    token: Token,
    recipientAddress: IAddress,
    signingService: SigningService
  ): Promise<TransferCommitment> {
    // Parse SDK token from stored data
    const tokenData = token.sdkData
      ? (typeof token.sdkData === 'string' ? JSON.parse(token.sdkData) : token.sdkData)
      : token;

    const sdkToken = await SdkToken.fromJSON(tokenData);

    // Generate random salt
    const salt = crypto.getRandomValues(new Uint8Array(32));

    // Create transfer commitment
    const commitment = await TransferCommitment.create(
      sdkToken,
      recipientAddress,
      salt,
      null, // recipientData
      null, // recipientDataHash
      signingService
    );

    return commitment;
  }

  /**
   * Create SigningService from identity private key
   */
  private async createSigningService(): Promise<SigningService> {
    const privateKeyHex = this.deps!.identity.privateKey;
    const privateKeyBytes = new Uint8Array(
      privateKeyHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
    );
    return SigningService.createFromSecret(privateKeyBytes);
  }

  /**
   * Create DirectAddress from a public key using UnmaskedPredicateReference
   */
  private async createDirectAddressFromPubkey(pubkeyHex: string): Promise<IAddress> {
    const { UnmaskedPredicateReference } = await import('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference');
    const { TokenType } = await import('@unicitylabs/state-transition-sdk/lib/token/TokenType');

    // Same token type used for address creation throughout the SDK
    const UNICITY_TOKEN_TYPE_HEX = 'f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509';
    const tokenType = new TokenType(Buffer.from(UNICITY_TOKEN_TYPE_HEX, 'hex'));

    // Convert hex pubkey to bytes
    const pubkeyBytes = new Uint8Array(
      pubkeyHex.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
    );

    // Create predicate reference with secp256k1 algorithm
    const addressRef = await UnmaskedPredicateReference.create(
      tokenType,
      'secp256k1',
      pubkeyBytes,
      HashAlgorithm.SHA256
    );

    return addressRef.toAddress();
  }

  /**
   * Resolve recipient to IAddress for L3 transfers.
   * Uses pre-resolved PeerInfo when available to avoid redundant network queries.
   */
  private async resolveRecipientAddress(
    recipient: string,
    addressMode: 'auto' | 'direct' | 'proxy' = 'auto',
    peerInfo?: PeerInfo | null,
  ): Promise<IAddress> {
    const { AddressFactory } = await import('@unicitylabs/state-transition-sdk/lib/address/AddressFactory');
    const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');

    // PROXY: or DIRECT: prefixed — parse directly (explicit address overrides mode)
    if (recipient.startsWith('PROXY:') || recipient.startsWith('DIRECT:')) {
      return AddressFactory.createAddress(recipient);
    }

    // 66-char hex (33-byte compressed pubkey) — create DirectAddress
    if (recipient.length === 66 && /^[0-9a-fA-F]+$/.test(recipient)) {
      this.log(`Creating DirectAddress from 33-byte compressed pubkey`);
      return this.createDirectAddressFromPubkey(recipient);
    }

    // For nametag-based recipients, use PeerInfo (pre-resolved or resolve now)
    const info = peerInfo ?? await this.deps?.transport.resolve?.(recipient) ?? null;
    if (!info) {
      throw new Error(
        `Recipient "${recipient}" not found. ` +
        `Use @nametag, a valid PROXY:/DIRECT: address, or a 33-byte hex pubkey.`
      );
    }

    // Determine nametag for PROXY address derivation
    const nametag = recipient.startsWith('@') ? recipient.slice(1)
      : info.nametag || recipient;

    // Force PROXY mode
    if (addressMode === 'proxy') {
      console.log(`[Payments] Using PROXY address for "${nametag}" (forced)`);
      return ProxyAddress.fromNameTag(nametag);
    }

    // Force DIRECT mode
    if (addressMode === 'direct') {
      if (!info.directAddress) {
        throw new Error(`"${nametag}" has no DirectAddress stored. It may be a legacy registration.`);
      }
      console.log(`[Payments] Using DirectAddress for "${nametag}" (forced): ${info.directAddress.slice(0, 30)}...`);
      return AddressFactory.createAddress(info.directAddress);
    }

    // AUTO mode: prefer directAddress, fallback to PROXY for legacy
    if (info.directAddress) {
      this.log(`Using DirectAddress for "${nametag}": ${info.directAddress.slice(0, 30)}...`);
      return AddressFactory.createAddress(info.directAddress);
    }

    this.log(`Using PROXY address for legacy nametag "${nametag}"`);
    return ProxyAddress.fromNameTag(nametag);
  }

  /**
   * Handle NOSTR-FIRST commitment-only transfer (recipient side)
   * This is called when receiving a transfer with only commitmentData and no proof yet.
   * We create the token as 'submitted', submit commitment (idempotent), and poll for proof.
   */
  private async handleCommitmentOnlyTransfer(
    transfer: IncomingTokenTransfer,
    payload: Record<string, unknown>
  ): Promise<void> {
    try {
      const sourceTokenInput = typeof payload.sourceToken === 'string'
        ? JSON.parse(payload.sourceToken as string)
        : payload.sourceToken;
      const commitmentInput = typeof payload.commitmentData === 'string'
        ? JSON.parse(payload.commitmentData as string)
        : payload.commitmentData;

      if (!sourceTokenInput || !commitmentInput) {
        console.warn('[Payments] Invalid NOSTR-FIRST transfer format');
        return;
      }

      // Parse source token info
      const tokenInfo = await parseTokenInfo(sourceTokenInput);

      // Create token with 'submitted' status (unconfirmed until proof received)
      const token: Token = {
        id: tokenInfo.tokenId ?? crypto.randomUUID(),
        coinId: tokenInfo.coinId,
        symbol: tokenInfo.symbol,
        name: tokenInfo.name,
        decimals: tokenInfo.decimals,
        iconUrl: tokenInfo.iconUrl,
        amount: tokenInfo.amount,
        status: 'submitted',  // NOSTR-FIRST: unconfirmed until proof
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sdkData: typeof sourceTokenInput === 'string'
          ? sourceTokenInput
          : JSON.stringify(sourceTokenInput),
      };

      // Check tombstones - reject tokens with exact (tokenId, stateHash) match
      // This prevents spent tokens from being re-added via Nostr re-delivery
      // Tokens with the same tokenId but DIFFERENT stateHash are allowed (new state)
      const nostrTokenId = extractTokenIdFromSdkData(token.sdkData);
      const nostrStateHash = extractStateHashFromSdkData(token.sdkData);
      if (nostrTokenId && nostrStateHash && this.isStateTombstoned(nostrTokenId, nostrStateHash)) {
        this.log(`NOSTR-FIRST: Rejecting tombstoned token ${nostrTokenId.slice(0, 8)}..._${nostrStateHash.slice(0, 8)}...`);
        return;
      }

      // Add token as unconfirmed
      this.tokens.set(token.id, token);
      await this.save();
      this.log(`NOSTR-FIRST: Token ${token.id.slice(0, 8)}... added as submitted (unconfirmed)`);

      // Emit event for incoming transfer (even though unconfirmed)
      const incomingTransfer: IncomingTransfer = {
        id: transfer.id,
        senderPubkey: transfer.senderTransportPubkey,
        tokens: [token],
        memo: payload.memo as string | undefined,
        receivedAt: transfer.timestamp,
      };
      this.deps!.emitEvent('transfer:incoming', incomingTransfer);

      // Parse commitment and start proof polling
      try {
        const commitment = await TransferCommitment.fromJSON(commitmentInput);
        const requestIdBytes = commitment.requestId;
        const requestIdHex = requestIdBytes instanceof Uint8Array
          ? Array.from(requestIdBytes).map(b => b.toString(16).padStart(2, '0')).join('')
          : String(requestIdBytes);

        // Submit commitment to aggregator (idempotent - same as sender)
        const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
        if (stClient) {
          const response = await stClient.submitTransferCommitment(commitment);
          this.log(`NOSTR-FIRST recipient commitment submit: ${response.status}`);
        }

        // Start polling for proof
        this.addProofPollingJob({
          tokenId: token.id,
          requestIdHex,
          commitmentJson: JSON.stringify(commitmentInput),
          startedAt: Date.now(),
          attemptCount: 0,
          lastAttemptAt: 0,
          onProofReceived: async (tokenId) => {
            // When proof arrives, finalize the token and update status
            await this.finalizeReceivedToken(tokenId, sourceTokenInput, commitmentInput, transfer.senderTransportPubkey);
          },
        });
      } catch (err) {
        console.error('[Payments] Failed to parse commitment for proof polling:', err);
        // Token remains as 'submitted' - will eventually time out
      }
    } catch (error) {
      console.error('[Payments] Failed to process NOSTR-FIRST transfer:', error);
    }
  }

  /**
   * Shared finalization logic for received transfers.
   * Handles both PROXY (with nametag token + address validation) and DIRECT schemes.
   */
  private async finalizeTransferToken(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sourceToken: SdkToken<any>,
    transferTx: TransferTransaction,
    stClient: StateTransitionClient,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trustBase: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<SdkToken<any>> {
    const recipientAddress = transferTx.data.recipient;
    const addressScheme = recipientAddress.scheme;
    const signingService = await this.createSigningService();
    const transferSalt = transferTx.data.salt;

    const recipientPredicate = await UnmaskedPredicate.create(
      sourceToken.id,
      sourceToken.type,
      signingService,
      HashAlgorithm.SHA256,
      transferSalt
    );
    const recipientState = new TokenState(recipientPredicate, null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let nametagTokens: SdkToken<any>[] = [];

    if (addressScheme === AddressScheme.PROXY) {
      // PROXY: Validate nametag address match (per reference impl)
      const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
      if (!this.nametag?.token) {
        throw new Error('Cannot finalize PROXY transfer - no nametag token');
      }
      const nametagToken = await SdkToken.fromJSON(this.nametag.token);
      const proxy = await ProxyAddress.fromTokenId(nametagToken.id);
      if (proxy.address !== recipientAddress.address) {
        throw new Error(
          `PROXY address mismatch: nametag resolves to ${proxy.address} ` +
          `but transfer targets ${recipientAddress.address}`
        );
      }
      nametagTokens = [nametagToken];
    }
    // DIRECT: nametagTokens stays empty []

    return stClient.finalizeTransaction(
      trustBase,
      sourceToken,
      recipientState,
      transferTx,
      nametagTokens
    );
  }

  /**
   * Finalize a received token after proof is available
   */
  private async finalizeReceivedToken(
    tokenId: string,
    sourceTokenInput: unknown,
    commitmentInput: unknown,
    senderPubkey: string
  ): Promise<void> {
    try {
      const token = this.tokens.get(tokenId);
      if (!token) {
        this.log(`Token ${tokenId} not found for finalization`);
        return;
      }

      // Get proof from aggregator
      const commitment = await TransferCommitment.fromJSON(commitmentInput);
      if (!this.deps!.oracle.waitForProofSdk) {
        this.log('Cannot finalize - no waitForProofSdk');
        token.status = 'confirmed'; // Mark as confirmed anyway
        token.updatedAt = Date.now();
        await this.save();
        return;
      }

      const inclusionProof = await this.deps!.oracle.waitForProofSdk(commitment);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transferTx = commitment.toTransaction(inclusionProof as any);

      // Parse source token
      const sourceToken = await SdkToken.fromJSON(sourceTokenInput);

      // Get state transition client
      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trustBase = (this.deps!.oracle as any).getTrustBase?.();

      if (!stClient || !trustBase) {
        this.log('Cannot finalize - missing state transition client or trust base');
        token.status = 'confirmed';
        token.updatedAt = Date.now();
        await this.save();
        return;
      }

      // Finalize using shared helper (handles PROXY address validation)
      const finalizedSdkToken = await this.finalizeTransferToken(
        sourceToken, transferTx, stClient, trustBase
      );

      // Update token with finalized data (create new token with updated sdkData)
      const finalizedToken: Token = {
        ...token,
        status: 'confirmed',
        updatedAt: Date.now(),
        sdkData: JSON.stringify(finalizedSdkToken.toJSON()),
      };
      this.tokens.set(tokenId, finalizedToken);
      await this.save();

      // Also save as individual token file
      await this.saveTokenToFileStorage(finalizedToken);

      this.log(`NOSTR-FIRST: Token ${tokenId.slice(0, 8)}... finalized and confirmed`);

      // Emit confirmation event
      this.deps!.emitEvent('transfer:confirmed', {
        id: crypto.randomUUID(),
        status: 'completed',
        tokens: [finalizedToken],
        tokenTransfers: [],
      });

      // Add to history
      await this.addToHistory({
        type: 'RECEIVED',
        amount: finalizedToken.amount,
        coinId: finalizedToken.coinId,
        symbol: finalizedToken.symbol,
        timestamp: Date.now(),
        senderPubkey,
      });
    } catch (error) {
      console.error('[Payments] Failed to finalize received token:', error);
      // Mark as confirmed anyway (user has the token)
      const token = this.tokens.get(tokenId);
      if (token && token.status === 'submitted') {
        token.status = 'confirmed';
        token.updatedAt = Date.now();
        await this.save();
      }
    }
  }

  private async handleIncomingTransfer(transfer: IncomingTokenTransfer): Promise<void> {
    try {
      // Check payload format - Sphere wallet sends { sourceToken, transferTx }
      // SDK format is { token, proof }
      // INSTANT_SPLIT format is { type: 'INSTANT_SPLIT', version, ... }
      const payload = transfer.payload as unknown as Record<string, unknown>;

      // Check for INSTANT_SPLIT bundle - may be the payload itself or nested in payload.token
      let instantBundle: InstantSplitBundle | null = null;
      if (isInstantSplitBundle(payload)) {
        instantBundle = payload as InstantSplitBundle;
      } else if (payload.token) {
        // InstantSplitExecutor wraps V5 bundle as { token: JSON.stringify(bundle), proof: null }
        try {
          const inner = typeof payload.token === 'string' ? JSON.parse(payload.token as string) : payload.token;
          if (isInstantSplitBundle(inner)) {
            instantBundle = inner as InstantSplitBundle;
          }
        } catch {
          // Not a JSON string or not a bundle - fall through
        }
      }

      if (instantBundle) {
        this.log('Processing INSTANT_SPLIT bundle...');
        try {
          // Ensure nametag is loaded before processing (needed for PROXY address verification)
          if (!this.nametag) {
            await this.loadNametagFromFileStorage();
          }

          const result = await this.processInstantSplitBundle(
            instantBundle,
            transfer.senderTransportPubkey
          );
          if (result.success) {
            this.log('INSTANT_SPLIT processed successfully');
          } else {
            console.warn('[Payments] INSTANT_SPLIT processing failed:', result.error);
          }
        } catch (err) {
          console.error('[Payments] INSTANT_SPLIT processing error:', err);
        }
        return;
      }

      // Check for NOSTR-FIRST commitment-only transfer (whole-token instant send)
      if (payload.sourceToken && payload.commitmentData && !payload.transferTx) {
        this.log('Processing NOSTR-FIRST commitment-only transfer...');
        await this.handleCommitmentOnlyTransfer(transfer, payload);
        return;
      }

      let tokenData: unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let finalizedSdkToken: SdkToken<any> | null = null;

      if (payload.sourceToken && payload.transferTx) {
        // Sphere wallet format - needs finalization for PROXY addresses
        this.log('Processing Sphere wallet format transfer...');

        const sourceTokenInput = typeof payload.sourceToken === 'string'
          ? JSON.parse(payload.sourceToken as string)
          : payload.sourceToken;
        const transferTxInput = typeof payload.transferTx === 'string'
          ? JSON.parse(payload.transferTx as string)
          : payload.transferTx;

        if (!sourceTokenInput || !transferTxInput) {
          console.warn('[Payments] Invalid Sphere wallet transfer format');
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let sourceToken: SdkToken<any>;
        let transferTx: TransferTransaction;

        try {
          sourceToken = await SdkToken.fromJSON(sourceTokenInput);
        } catch (err) {
          console.error('[Payments] Failed to parse sourceToken:', err);
          return;
        }

        // Try multiple parsing strategies for transferTx
        // Format 1: TransferTransaction - has { data, inclusionProof }
        // Format 2: TransferCommitment - has { authenticator, requestId, transactionData }
        try {
          // Detect format based on structure
          const hasInclusionProof = transferTxInput.inclusionProof !== undefined;
          const hasData = transferTxInput.data !== undefined;
          const hasTransactionData = transferTxInput.transactionData !== undefined;
          const hasAuthenticator = transferTxInput.authenticator !== undefined;

          if (hasData && hasInclusionProof) {
            // Full transaction format - parse directly
            transferTx = await TransferTransaction.fromJSON(transferTxInput);
          } else if (hasTransactionData && hasAuthenticator) {
            // Commitment format - submit and wait for proof
            const commitment = await TransferCommitment.fromJSON(transferTxInput);
            const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
            if (!stClient) {
              console.error('[Payments] Cannot process commitment - no state transition client');
              return;
            }

            const response = await stClient.submitTransferCommitment(commitment);
            if (response.status !== 'SUCCESS' && response.status !== 'REQUEST_ID_EXISTS') {
              console.error('[Payments] Transfer commitment submission failed:', response.status);
              return;
            }

            if (!this.deps!.oracle.waitForProofSdk) {
              console.error('[Payments] Cannot wait for proof - missing oracle method');
              return;
            }
            const inclusionProof = await this.deps!.oracle.waitForProofSdk(commitment);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            transferTx = commitment.toTransaction(inclusionProof as any);
          } else {
            // Unknown format - try parsing approaches
            try {
              transferTx = await TransferTransaction.fromJSON(transferTxInput);
            } catch {
              // Try commitment format as fallback
              const commitment = await TransferCommitment.fromJSON(transferTxInput);
              const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
              if (!stClient || !this.deps!.oracle.waitForProofSdk) {
                throw new Error('Cannot submit commitment - missing oracle methods');
              }
              await stClient.submitTransferCommitment(commitment);
              const inclusionProof = await this.deps!.oracle.waitForProofSdk(commitment);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              transferTx = commitment.toTransaction(inclusionProof as any);
            }
          }
        } catch (err) {
          console.error('[Payments] Failed to parse transferTx:', err);
          return;
        }

        // Finalize using shared helper (handles PROXY address validation)
        try {
          const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const trustBase = (this.deps!.oracle as any).getTrustBase?.();
          if (!stClient || !trustBase) {
            console.error('[Payments] Cannot finalize - missing state transition client or trust base. Token rejected.');
            return;
          }
          finalizedSdkToken = await this.finalizeTransferToken(sourceToken, transferTx, stClient, trustBase);
          tokenData = finalizedSdkToken.toJSON();
          const addressScheme = transferTx.data.recipient.scheme;
          this.log(`${addressScheme === AddressScheme.PROXY ? 'PROXY' : 'DIRECT'} finalization successful`);
        } catch (finalizeError) {
          console.error(`[Payments] Finalization FAILED - token rejected:`, finalizeError);
          return;
        }
      } else if (payload.token) {
        // SDK format
        tokenData = payload.token;
      } else {
        console.warn('[Payments] Unknown transfer payload format');
        return;
      }

      // Validate token
      const validation = await this.deps!.oracle.validateToken(tokenData);
      if (!validation.valid) {
        console.warn('[Payments] Received invalid token');
        return;
      }

      // Parse token info from SDK data
      const tokenInfo = await parseTokenInfo(tokenData);

      // Create token entry
      const token: Token = {
        id: tokenInfo.tokenId ?? crypto.randomUUID(),
        coinId: tokenInfo.coinId,
        symbol: tokenInfo.symbol,
        name: tokenInfo.name,
        decimals: tokenInfo.decimals,
        iconUrl: tokenInfo.iconUrl,
        amount: tokenInfo.amount,
        status: 'confirmed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sdkData: typeof tokenData === 'string'
          ? tokenData
          : JSON.stringify(tokenData),
      };

      // addToken() checks tombstones with exact (tokenId, stateHash) match
      // Tokens with same tokenId but different stateHash pass through (new state)
      await this.addToken(token);

      const incomingTransfer: IncomingTransfer = {
        id: transfer.id,
        senderPubkey: transfer.senderTransportPubkey,
        tokens: [token],
        memo: payload.memo as string | undefined,
        receivedAt: transfer.timestamp,
      };

      this.deps!.emitEvent('transfer:incoming', incomingTransfer);
      this.log(`Incoming transfer processed: ${token.id}, ${token.amount} ${token.symbol}`);
    } catch (error) {
      console.error('[Payments] Failed to process incoming transfer:', error);
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
        this.log(`Updated archived token ${tokenId.slice(0, 8)}...`);
      } else {
        // Fork
        const stateHash = getCurrentStateHash(txf) || '';
        await this.storeForkedToken(tokenId, stateHash, txf);
        this.log(`Archived token ${tokenId.slice(0, 8)}... is a fork`);
      }
    } else {
      this.archivedTokens.set(tokenId, txf);
      this.log(`Archived token ${tokenId.slice(0, 8)}...`);
    }
  }

  // ===========================================================================
  // Private: Storage
  // ===========================================================================

  private async save(): Promise<void> {
    // Save to TokenStorageProviders (IndexedDB/files)
    const providers = this.getTokenStorageProviders();
    if (providers.size === 0) {
      this.log('No token storage providers - tokens not persisted');
      return;
    }

    const data = await this.createStorageData();
    for (const [id, provider] of providers) {
      // Skip sync-only providers (e.g. IPFS) — they publish via sync(), not save()
      if (provider.syncOnly) continue;
      try {
        await provider.save(data);
      } catch (err) {
        console.error(`[Payments] Failed to save to provider ${id}:`, err);
      }
    }

    // Save pending V5 tokens separately (TXF can't represent them)
    await this.savePendingV5Tokens();
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

  private async createStorageData(): Promise<TxfStorageDataBase> {
    // Active tokens are NOT stored in TXF format - they are saved as individual
    // token-xxx files via saveTokenToFileStorage() to avoid duplication.
    // TXF storage is only used for metadata: archived, tombstones, forked, outbox.
    // Note: nametag is also saved separately via saveNametagToFileStorage()
    // as nametag-{name}.json to avoid duplication in storage
    return await buildTxfStorageData(
      [], // Empty - active tokens stored as token-xxx files
      {
        version: 1,
        address: this.deps!.identity.l1Address,
        ipnsName: this.deps!.identity.ipnsName ?? '',
      },
      {
        tombstones: this.tombstones,
        archivedTokens: this.archivedTokens,
        forkedTokens: this.forkedTokens,
      }
    ) as unknown as TxfStorageDataBase;
  }

  private loadFromStorageData(data: TxfStorageDataBase): void {
    const parsed = parseTxfStorageData(data);

    // Load tombstones FIRST so we can filter tokens
    this.tombstones = parsed.tombstones;
    // Load tokens, filtering out tombstoned ones
    // NOTE: Only filter by exact (tokenId, stateHash) match to avoid over-blocking
    // When state hash is unavailable, we can't reliably distinguish old from new
    this.tokens.clear();
    for (const token of parsed.tokens) {
      const sdkTokenId = extractTokenIdFromSdkData(token.sdkData);
      const stateHash = extractStateHashFromSdkData(token.sdkData);

      // Only filter if we have exact state match
      if (sdkTokenId && stateHash && this.isStateTombstoned(sdkTokenId, stateHash)) {
        this.log(`Skipping tombstoned token ${sdkTokenId.slice(0, 8)}... during load (exact state match)`);
        continue;
      }

      this.tokens.set(token.id, token);
    }

    // Load other data
    this.archivedTokens = parsed.archivedTokens;
    this.forkedTokens = parsed.forkedTokens;
    // Only overwrite nametag if TXF data explicitly includes one.
    // Nametag is stored separately as nametag-{name} files (not in TXF),
    // so parsed.nametag is normally null and must not erase the existing value.
    if (parsed.nametag !== null) {
      this.nametag = parsed.nametag;
    }
  }

  // ===========================================================================
  // Private: NOSTR-FIRST Proof Polling
  // ===========================================================================

  /**
   * Submit commitment to aggregator and start background proof polling
   * (NOSTR-FIRST pattern: fire-and-forget submission)
   */
  private async submitAndPollForProof(
    tokenId: string,
    commitment: TransferCommitment,
    requestIdHex: string,
    onProofReceived?: (tokenId: string) => void
  ): Promise<void> {
    try {
      // Submit to aggregator
      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      if (!stClient) {
        this.log('Cannot submit commitment - no state transition client');
        return;
      }

      const response = await stClient.submitTransferCommitment(commitment);
      if (response.status !== 'SUCCESS' && response.status !== 'REQUEST_ID_EXISTS') {
        this.log(`Transfer commitment submission failed: ${response.status}`);
        // Mark token as invalid since submission failed
        const token = this.tokens.get(tokenId);
        if (token) {
          token.status = 'invalid';
          token.updatedAt = Date.now();
          this.tokens.set(tokenId, token);
          await this.save();
        }
        return;
      }

      // Add to polling queue
      this.addProofPollingJob({
        tokenId,
        requestIdHex,
        commitmentJson: JSON.stringify(commitment.toJSON()),
        startedAt: Date.now(),
        attemptCount: 0,
        lastAttemptAt: 0,
        onProofReceived,
      });
    } catch (error) {
      this.log('submitAndPollForProof error:', error);
    }
  }

  /**
   * Add a proof polling job to the queue
   */
  private addProofPollingJob(job: ProofPollingJob): void {
    this.proofPollingJobs.set(job.tokenId, job);
    this.log(`Added proof polling job for token ${job.tokenId.slice(0, 8)}...`);
    this.startProofPolling();
  }

  /**
   * Start the proof polling interval if not already running
   */
  private startProofPolling(): void {
    if (this.proofPollingInterval) return;
    if (this.proofPollingJobs.size === 0) return;

    this.log('Starting proof polling...');
    this.proofPollingInterval = setInterval(
      () => this.processProofPollingQueue(),
      PaymentsModule.PROOF_POLLING_INTERVAL_MS
    );
  }

  /**
   * Stop the proof polling interval
   */
  private stopProofPolling(): void {
    if (this.proofPollingInterval) {
      clearInterval(this.proofPollingInterval);
      this.proofPollingInterval = null;
      this.log('Stopped proof polling');
    }
  }

  /**
   * Process all pending proof polling jobs
   */
  private async processProofPollingQueue(): Promise<void> {
    if (this.proofPollingJobs.size === 0) {
      this.stopProofPolling();
      return;
    }

    const completedJobs: string[] = [];

    for (const [tokenId, job] of this.proofPollingJobs) {
      try {
        job.attemptCount++;
        job.lastAttemptAt = Date.now();

        // Check for timeout
        if (job.attemptCount >= PaymentsModule.PROOF_POLLING_MAX_ATTEMPTS) {
          this.log(`Proof polling timeout for token ${tokenId.slice(0, 8)}...`);
          // Mark token as invalid due to timeout
          const token = this.tokens.get(tokenId);
          if (token && token.status === 'submitted') {
            token.status = 'invalid';
            token.updatedAt = Date.now();
            this.tokens.set(tokenId, token);
          }
          completedJobs.push(tokenId);
          continue;
        }

        // Try to get proof from aggregator using a short timeout
        const commitment = await TransferCommitment.fromJSON(JSON.parse(job.commitmentJson));

        // Try to get proof with a quick timeout (non-blocking check)
        let inclusionProof: unknown = null;
        try {
          // Create abort controller for quick timeout
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), 500);

          if (this.deps!.oracle.waitForProofSdk) {
            inclusionProof = await Promise.race([
              this.deps!.oracle.waitForProofSdk(commitment, abortController.signal),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
            ]);
          } else {
            // Fallback: use getProof with request ID hex
            const proof = await this.deps!.oracle.getProof(job.requestIdHex);
            if (proof) {
              inclusionProof = proof;
            }
          }

          clearTimeout(timeoutId);
        } catch (err) {
          // Proof not ready yet or timed out
          continue;
        }

        if (!inclusionProof) {
          // Proof not ready yet
          continue;
        }

        // Proof received! Update token status
        const token = this.tokens.get(tokenId);
        if (token) {
          token.status = 'spent';
          token.updatedAt = Date.now();
          this.tokens.set(tokenId, token);
          await this.save();
          this.log(`Proof received for token ${tokenId.slice(0, 8)}..., status: spent`);
        }

        // Call callback if provided
        job.onProofReceived?.(tokenId);
        completedJobs.push(tokenId);
      } catch (error) {
        // Most errors mean proof is not ready yet, continue polling
        this.log(`Proof polling attempt ${job.attemptCount} for ${tokenId.slice(0, 8)}...: ${error}`);
      }
    }

    // Remove completed jobs
    for (const tokenId of completedJobs) {
      this.proofPollingJobs.delete(tokenId);
    }

    // Stop polling if no more jobs
    if (this.proofPollingJobs.size === 0) {
      this.stopProofPolling();
    }
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  private ensureInitialized(): void {
    if (!this.deps) {
      throw new Error('PaymentsModule not initialized');
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

export function createPaymentsModule(config?: PaymentsModuleConfig): PaymentsModule {
  return new PaymentsModule(config);
}
