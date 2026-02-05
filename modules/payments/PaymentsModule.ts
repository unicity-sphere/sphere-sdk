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
  Token,
  TokenBalance,
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
  IncomingTokenTransfer,
  PaymentRequestPayload,
  PaymentRequestResponsePayload,
  IncomingPaymentRequest as TransportPaymentRequest,
  IncomingPaymentRequestResponse as TransportPaymentRequestResponse,
} from '../../transport';
import type { OracleProvider } from '../../oracle';
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
  InstantSplitResult,
  InstantSplitProcessResult,
  InstantSplitOptions,
} from '../../types/instant-split';
import { isInstantSplitBundle } from '../../types/instant-split';

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
import type { IAddress } from '@unicitylabs/state-transition-sdk/lib/address/IAddress';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';

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
  txHash?: string;
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
        defaultInfo.tokenId = sdkToken.id.toString();
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
 * Extract token ID from sdkData/jsonData
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
    return getCurrentStateHash(txf) || '';
  } catch {
    return '';
  }
}

/**
 * Check if two tokens are the same (by genesis tokenId)
 */
function isSameToken(t1: Token, t2: Token): boolean {
  if (t1.id === t2.id) return true;

  const id1 = extractTokenIdFromSdkData(t1.sdkData);
  const id2 = extractTokenIdFromSdkData(t2.sdkData);

  return !!(id1 && id2 && id1 === id2);
}

/**
 * Create tombstone from token
 */
function createTombstoneFromToken(token: Token): TombstoneEntry | null {
  const tokenId = extractTokenIdFromSdkData(token.sdkData);
  if (!tokenId) return null;

  const stateHash = extractStateHashFromSdkData(token.sdkData);

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
  /** L1 (ALPHA blockchain) configuration */
  l1?: L1PaymentsModuleConfig;
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

  constructor(config?: PaymentsModuleConfig) {
    this.moduleConfig = {
      autoSync: config?.autoSync ?? true,
      autoValidate: config?.autoValidate ?? true,
      retryFailed: config?.retryFailed ?? true,
      maxRetries: config?.maxRetries ?? 3,
      debug: config?.debug ?? false,
    };

    // Initialize L1 sub-module only if electrumUrl is provided
    const l1Enabled = config?.l1?.electrumUrl && config.l1.electrumUrl.length > 0;
    this.l1 = l1Enabled ? new L1PaymentsModule(config?.l1) : null;
  }

  /** Get module configuration */
  getConfig(): Omit<Required<PaymentsModuleConfig>, 'l1'> {
    return this.moduleConfig;
  }

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
    this.deps = deps;

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
    this.unsubscribeTransfers = deps.transport.onTokenTransfer((transfer) => {
      this.handleIncomingTransfer(transfer);
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
  }

  /**
   * Load tokens from storage
   */
  async load(): Promise<void> {
    this.ensureInitialized();

    // Load from TokenStorageProviders (IndexedDB/files)
    const providers = this.getTokenStorageProviders();
    for (const [id, provider] of providers) {
      try {
        const result = await provider.load();
        if (result.success && result.data) {
          this.loadFromStorageData(result.data);
          this.log(`Loaded from provider ${id}: ${this.tokens.size} tokens`);
          break; // Use first successful provider
        }
      } catch (err) {
        console.error(`[Payments] Failed to load from provider ${id}:`, err);
      }
    }

    // Legacy: Load tokens from file storage (lottery compatibility)
    if (this.tokens.size === 0) {
      await this.loadTokensFromFileStorage();
    }

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
  }

  /**
   * Cleanup resources
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
    };

    try {
      // Resolve recipient pubkey for Nostr delivery
      const recipientPubkey = await this.resolveRecipient(request.recipient);

      // Resolve recipient address for on-chain transfer
      const recipientAddress = await this.resolveRecipientAddress(request.recipient);

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

      // Handle split if required
      if (splitPlan.requiresSplit && splitPlan.tokenToSplit) {
        this.log('Executing token split...');

        const executor = new TokenSplitExecutor({
          stateTransitionClient: stClient,
          trustBase,
          signingService,
        });

        const splitResult = await executor.executeSplit(
          splitPlan.tokenToSplit.sdkToken,
          splitPlan.splitAmount!,
          splitPlan.remainderAmount!,
          splitPlan.coinId,
          recipientAddress
        );

        // Save change token for sender
        const changeTokenData = splitResult.tokenForSender.toJSON();
        const changeToken: Token = {
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
        await this.addToken(changeToken, true); // Skip history for change
        this.log(`Change token saved: ${changeToken.id}, amount: ${changeToken.amount}`);

        // Send recipient token via Nostr (Sphere format)
        console.log(`[Payments] Sending split token to ${recipientPubkey.slice(0, 8)}... via Nostr`);
        await this.deps!.transport.sendTokenTransfer(recipientPubkey, {
          sourceToken: JSON.stringify(splitResult.tokenForRecipient.toJSON()),
          transferTx: JSON.stringify(splitResult.recipientTransferTx.toJSON()),
          memo: request.memo,
        } as unknown as import('../../transport').TokenTransferPayload);
        console.log(`[Payments] Split token sent successfully`);

        // Remove the original token that was split
        await this.removeToken(splitPlan.tokenToSplit.uiToken.id, recipientNametag);

        result.txHash = 'split-' + Date.now().toString(16);
        this.log(`Split transfer completed`);
      }

      // Transfer direct tokens (no split needed)
      for (const tokenWithAmount of splitPlan.tokensToTransferDirectly) {
        const token = tokenWithAmount.uiToken;

        // Create SDK transfer commitment
        const commitment = await this.createSdkCommitment(token, recipientAddress, signingService);

        // Submit commitment via SDK
        const response = await stClient.submitTransferCommitment(commitment);
        if (response.status !== 'SUCCESS' && response.status !== 'REQUEST_ID_EXISTS') {
          throw new Error(`Transfer commitment failed: ${response.status}`);
        }

        // Wait for inclusion proof using SDK
        if (!this.deps!.oracle.waitForProofSdk) {
          throw new Error('Oracle provider must implement waitForProofSdk()');
        }
        const inclusionProof = await this.deps!.oracle.waitForProofSdk(commitment);

        // Create transfer transaction
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const transferTx = commitment.toTransaction(inclusionProof as any);

        // Get request ID as hex string for tracking
        const requestIdBytes = commitment.requestId;
        result.txHash = requestIdBytes instanceof Uint8Array
          ? Array.from(requestIdBytes).map(b => b.toString(16).padStart(2, '0')).join('')
          : String(requestIdBytes);

        // Send via transport (Nostr) - use Sphere-compatible format
        console.log(`[Payments] Sending direct token ${token.id.slice(0, 8)}... to ${recipientPubkey.slice(0, 8)}... via Nostr`);
        await this.deps!.transport.sendTokenTransfer(recipientPubkey, {
          sourceToken: JSON.stringify(tokenWithAmount.sdkToken.toJSON()),
          transferTx: JSON.stringify(transferTx.toJSON()),
          memo: request.memo,
        } as unknown as import('../../transport').TokenTransferPayload);
        console.log(`[Payments] Direct token sent successfully`);

        this.log(`Token ${token.id} transferred, txHash: ${result.txHash}`);

        // Remove sent token (creates tombstone)
        await this.removeToken(token.id, recipientNametag);
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
      // Resolve recipient pubkey for Nostr delivery
      const recipientPubkey = await this.resolveRecipient(request.recipient);

      // Resolve recipient address for on-chain transfer
      const recipientAddress = await this.resolveRecipientAddress(request.recipient);

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
        // Remove the original token
        const recipientNametag = request.recipient.startsWith('@') ? request.recipient.slice(1) : undefined;
        await this.removeToken(tokenToSplit.id, recipientNametag);

        // Add to transaction history
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
  async processInstantSplitBundle(
    bundle: InstantSplitBundle,
    senderPubkey: string
  ): Promise<InstantSplitProcessResult> {
    this.ensureInitialized();

    try {
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

      // Check if dev mode
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const devMode = (this.deps!.oracle as any).isDevMode?.() ?? false;

      // Create processor
      const processor = new InstantSplitProcessor({
        stateTransitionClient: stClient,
        trustBase,
        devMode,
      });

      // Process the bundle
      const result = await processor.processReceivedBundle(
        bundle,
        signingService,
        senderPubkey,
        {
          findNametagToken: async (_proxyAddress: string) => {
            // Return nametag token if available
            if (this.nametag?.token) {
              try {
                return await SdkToken.fromJSON(this.nametag.token);
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
        // Save the received token
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

        // Add to history
        await this.addToHistory({
          type: 'RECEIVED',
          amount: bundle.amount,
          coinId: info.coinId,
          symbol: info.symbol,
          timestamp: Date.now(),
          senderPubkey,
        });

        await this.save();

        // Emit event
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
   * Check if a payload is an instant split bundle
   */
  isInstantSplitBundle(payload: unknown): payload is InstantSplitBundle {
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
      // Resolve recipient pubkey
      const recipientPubkey = await this.resolveRecipient(recipientPubkeyOrNametag);

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
   * Get pending payment requests count
   */
  getPendingPaymentRequestsCount(): number {
    return this.paymentRequests.filter((r) => r.status === 'pending').length;
  }

  /**
   * Accept a payment request (marks it as accepted, user should then call send())
   */
  async acceptPaymentRequest(requestId: string): Promise<void> {
    this.updatePaymentRequestStatus(requestId, 'accepted');
    await this.sendPaymentRequestResponse(requestId, 'accepted');
  }

  /**
   * Reject a payment request
   */
  async rejectPaymentRequest(requestId: string): Promise<void> {
    this.updatePaymentRequestStatus(requestId, 'rejected');
    await this.sendPaymentRequestResponse(requestId, 'rejected');
  }

  /**
   * Mark a payment request as paid (after successful transfer)
   */
  markPaymentRequestPaid(requestId: string): void {
    this.updatePaymentRequestStatus(requestId, 'paid');
  }

  /**
   * Clear processed (non-pending) payment requests
   */
  clearProcessedPaymentRequests(): void {
    this.paymentRequests = this.paymentRequests.filter((r) => r.status === 'pending');
  }

  /**
   * Remove a specific payment request
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
    const request: IncomingPaymentRequest = {
      id: transportRequest.id,
      senderPubkey: transportRequest.senderTransportPubkey,
      amount: transportRequest.request.amount,
      coinId: transportRequest.request.coinId,
      symbol: transportRequest.request.coinId, // Use coinId as symbol for now
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
   * Cancel waiting for a payment response
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
   * Remove an outgoing payment request
   */
  removeOutgoingPaymentRequest(requestId: string): void {
    this.outgoingPaymentRequests.delete(requestId);
    this.cancelWaitForPaymentResponse(requestId);
  }

  /**
   * Clear completed/expired outgoing payment requests
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
  // Public API - Balance & Tokens
  // ===========================================================================

  /**
   * Get balance for coin type
   */
  getBalance(coinId?: string): TokenBalance[] {
    const balances = new Map<string, TokenBalance>();
    const registry = TokenRegistry.getInstance();

    for (const token of this.tokens.values()) {
      if (token.status !== 'confirmed') continue;
      if (coinId && token.coinId !== coinId) continue;

      const key = token.coinId;
      const existing = balances.get(key);

      if (existing) {
        (existing as { totalAmount: string }).totalAmount = (
          BigInt(existing.totalAmount) + BigInt(token.amount)
        ).toString();
        (existing as { tokenCount: number }).tokenCount++;
      } else {
        // Look up token metadata from registry (more reliable than stored values)
        const def = registry.getDefinition(token.coinId);
        balances.set(key, {
          coinId: token.coinId,
          symbol: def?.symbol || token.symbol,
          name: def?.name ? def.name.charAt(0).toUpperCase() + def.name.slice(1) : token.name,
          totalAmount: token.amount,
          tokenCount: 1,
          decimals: def?.decimals ?? token.decimals ?? 8,
        });
      }
    }

    return Array.from(balances.values());
  }

  /**
   * Get all tokens
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
   * Get single token
   */
  getToken(id: string): Token | undefined {
    return this.tokens.get(id);
  }

  // ===========================================================================
  // Public API - Token Operations
  // ===========================================================================

  /**
   * Add a token
   * @returns false if duplicate
   */
  async addToken(token: Token, skipHistory: boolean = false): Promise<boolean> {
    this.ensureInitialized();

    // Check for duplicates
    for (const existing of this.tokens.values()) {
      if (isSameToken(existing, token)) {
        this.log(`Duplicate token detected: ${token.id}`);
        return false;
      }
    }

    this.tokens.set(token.id, token);

    // Archive the token
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
    await this.saveTokenToFileStorage(token);

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
        const tokenIds = await provider.listTokenIds();
        this.log(`Found ${tokenIds.length} token files in ${providerId}`);

        for (const tokenId of tokenIds) {
          try {
            const fileData = await provider.getToken(tokenId);
            if (!fileData || typeof fileData !== 'object') continue;

            // Handle lottery format: { token, receivedAt } or { token, receivedAt, meta }
            const data = fileData as Record<string, unknown>;
            const tokenJson = data.token;
            if (!tokenJson) continue;

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

    // Save to key-value storage to sync
    if (this.tokens.size > 0) {
      await this.save();
    }
  }

  /**
   * Update an existing token
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
   * Remove a token by ID
   */
  async removeToken(tokenId: string, recipientNametag?: string, skipHistory: boolean = false): Promise<void> {
    this.ensureInitialized();

    const token = this.tokens.get(tokenId);
    if (!token) return;

    // Archive before removing
    await this.archiveToken(token);

    // Create tombstone
    const tombstone = createTombstoneFromToken(token);
    if (tombstone) {
      const alreadyTombstoned = this.tombstones.some(
        t => t.tokenId === tombstone.tokenId && t.stateHash === tombstone.stateHash
      );
      if (!alreadyTombstoned) {
        this.tombstones.push(tombstone);
        this.log(`Created tombstone for ${tombstone.tokenId.slice(0, 8)}...`);
      }
    }

    // Remove from active tokens
    this.tokens.delete(tokenId);

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

  // ===========================================================================
  // Public API - Tombstones
  // ===========================================================================

  /**
   * Get all tombstones
   */
  getTombstones(): TombstoneEntry[] {
    return [...this.tombstones];
  }

  /**
   * Check if token state is tombstoned
   */
  isStateTombstoned(tokenId: string, stateHash: string): boolean {
    return this.tombstones.some(
      t => t.tokenId === tokenId && t.stateHash === stateHash
    );
  }

  /**
   * Merge remote tombstones
   * @returns number of local tokens removed
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
   * Prune old tombstones
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
   * Get archived tokens
   */
  getArchivedTokens(): Map<string, TxfToken> {
    return new Map(this.archivedTokens);
  }

  /**
   * Get best archived version of a token
   */
  getBestArchivedVersion(tokenId: string): TxfToken | null {
    return findBestTokenVersion(tokenId, this.archivedTokens, this.forkedTokens);
  }

  /**
   * Merge remote archived tokens
   * @returns number of tokens updated/added
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
   * Prune archived tokens
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
   * Get forked tokens
   */
  getForkedTokens(): Map<string, TxfToken> {
    return new Map(this.forkedTokens);
  }

  /**
   * Store a forked token
   */
  async storeForkedToken(tokenId: string, stateHash: string, txfToken: TxfToken): Promise<void> {
    const key = `${tokenId}_${stateHash}`;
    if (this.forkedTokens.has(key)) return;

    this.forkedTokens.set(key, txfToken);
    this.log(`Stored forked token ${tokenId.slice(0, 8)}... state ${stateHash.slice(0, 12)}...`);
    await this.save();
  }

  /**
   * Merge remote forked tokens
   * @returns number of tokens added
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
   * Prune forked tokens
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
   * Get transaction history
   */
  getHistory(): TransactionHistoryEntry[] {
    return [...this.transactionHistory].sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Add to transaction history
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
   * Set nametag for current identity
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
   * Get nametag
   */
  getNametag(): NametagData | null {
    return this.nametag;
  }

  /**
   * Check if has nametag
   */
  hasNametag(): boolean {
    return this.nametag !== null;
  }

  /**
   * Clear nametag
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
   * Sync with all token storage providers (IPFS, MongoDB, etc.)
   * Syncs with each provider and merges results
   */
  async sync(): Promise<{ added: number; removed: number }> {
    this.ensureInitialized();

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
   * Update token storage providers (called when providers are added/removed dynamically)
   */
  updateTokenStorageProviders(providers: Map<string, TokenStorageProvider<TxfStorageDataBase>>): void {
    if (this.deps) {
      this.deps.tokenStorageProviders = providers;
    }
  }

  /**
   * Validate tokens with aggregator
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
   * Get pending transfers
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
  private isL3Address(value: string): boolean {
    // PROXY: or DIRECT: prefixed addresses
    if (value.startsWith('PROXY:') || value.startsWith('DIRECT:')) {
      return true;
    }
    // Hex pubkey (64+ hex chars)
    if (value.length >= 64 && /^[0-9a-fA-F]+$/.test(value)) {
      return true;
    }
    return false;
  }

  /**
   * Resolve recipient to Nostr pubkey for messaging
   * Supports: nametag (with or without @), hex pubkey
   */
  private async resolveRecipient(recipient: string): Promise<string> {
    // Explicit nametag with @
    if (recipient.startsWith('@')) {
      const nametag = recipient.slice(1);
      const pubkey = await this.deps!.transport.resolveNametag?.(nametag);
      if (!pubkey) {
        throw new Error(`Nametag not found: ${nametag}`);
      }
      return pubkey;
    }

    // If it looks like an L3 address, return as-is (it's a pubkey)
    if (this.isL3Address(recipient)) {
      return recipient;
    }

    // Smart detection: try as nametag first
    if (this.deps?.transport.resolveNametag) {
      const pubkey = await this.deps.transport.resolveNametag(recipient);
      if (pubkey) {
        this.log(`Resolved "${recipient}" as nametag to pubkey`);
        return pubkey;
      }
    }

    // If not found as nametag and doesn't look like an address, throw error
    throw new Error(
      `Recipient "${recipient}" is not a valid nametag or address. ` +
      `Use @nametag for explicit nametag or a valid hex pubkey/PROXY:/DIRECT: address.`
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
   * Resolve nametag to 33-byte compressed public key using resolveNametagInfo
   * Returns null if nametag not found
   *
   * NOTE: Legacy nametags without chainPubkey CANNOT be used for transfers.
   * The transportPubkey (Nostr pubkey) is a different key from the L3 chainPubkey,
   * so deriving one from the other is impossible. Legacy nametags must be re-registered
   * with the new SDK format that includes chainPubkey.
   */
  private async resolveNametagToPublicKey(nametag: string): Promise<string | null> {
    if (!this.deps?.transport.resolveNametagInfo) {
      this.log('resolveNametagInfo not available on transport');
      return null;
    }

    const info = await this.deps.transport.resolveNametagInfo(nametag);
    if (!info) {
      this.log(`Nametag "${nametag}" not found`);
      return null;
    }

    // Use chainPubkey if available (required for correct address derivation)
    if (info.chainPubkey) {
      return info.chainPubkey;
    }

    // Legacy nametag without chainPubkey - PROXY fallback will be used in resolveRecipientAddress
    this.log(`Nametag "${nametag}" has no chainPubkey - will use PROXY address fallback`);
    return null;
  }

  /**
   * Resolve recipient to IAddress for L3 transfers
   * Supports: nametag (with or without @), PROXY:, DIRECT:, hex pubkey
   */
  private async resolveRecipientAddress(recipient: string): Promise<IAddress> {
    const { AddressFactory } = await import('@unicitylabs/state-transition-sdk/lib/address/AddressFactory');

    // Explicit nametag with @ - resolve to 33-byte pubkey and use DirectAddress
    if (recipient.startsWith('@')) {
      const nametag = recipient.slice(1);
      const publicKey = await this.resolveNametagToPublicKey(nametag);
      if (publicKey) {
        this.log(`Resolved @${nametag} to 33-byte publicKey for DirectAddress`);
        return this.createDirectAddressFromPubkey(publicKey);
      }

      // FALLBACK: Use PROXY address for legacy nametags without chainPubkey
      const info = await this.deps?.transport.resolveNametagInfo?.(nametag);
      if (info) {
        const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
        this.log(`Using PROXY address for legacy nametag @${nametag}`);
        return ProxyAddress.fromNameTag(nametag);
      }

      throw new Error(`Nametag "@${nametag}" not found`);
    }

    // PROXY: or DIRECT: prefixed - parse using AddressFactory
    if (recipient.startsWith('PROXY:') || recipient.startsWith('DIRECT:')) {
      return AddressFactory.createAddress(recipient);
    }

    // If it looks like a hex pubkey (66 chars = 33 bytes compressed), create DirectAddress
    if (recipient.length === 66 && /^[0-9a-fA-F]+$/.test(recipient)) {
      this.log(`Creating DirectAddress from 33-byte compressed pubkey`);
      return this.createDirectAddressFromPubkey(recipient);
    }

    // Smart detection: try as nametag - resolve to 33-byte pubkey and use DirectAddress
    const publicKey = await this.resolveNametagToPublicKey(recipient);
    if (publicKey) {
      this.log(`Resolved "${recipient}" as nametag to 33-byte publicKey for DirectAddress`);
      return this.createDirectAddressFromPubkey(publicKey);
    }

    // FALLBACK: Use PROXY address for legacy nametags without chainPubkey
    const info = await this.deps?.transport.resolveNametagInfo?.(recipient);
    if (info) {
      const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
      this.log(`Using PROXY address for legacy nametag "${recipient}"`);
      return ProxyAddress.fromNameTag(recipient);
    }

    // Not found as nametag and doesn't look like an address
    throw new Error(
      `Recipient "${recipient}" is not a valid nametag or L3 address. ` +
      `Use @nametag for explicit nametag or a valid 33-byte hex pubkey/PROXY:/DIRECT: address.`
    );
  }

  private async handleIncomingTransfer(transfer: IncomingTokenTransfer): Promise<void> {
    try {
      // Check payload format - Sphere wallet sends { sourceToken, transferTx }
      // SDK format is { token, proof }
      // INSTANT_SPLIT format is { type: 'INSTANT_SPLIT', version, ... }
      const payload = transfer.payload as unknown as Record<string, unknown>;

      // Check for INSTANT_SPLIT bundle first (V4 or V5)
      if (isInstantSplitBundle(payload)) {
        this.log('Processing INSTANT_SPLIT bundle...');
        try {
          // Ensure nametag is loaded before processing (needed for PROXY address verification)
          if (!this.nametag) {
            await this.loadNametagFromFileStorage();
          }

          const result = await this.processInstantSplitBundle(
            payload as InstantSplitBundle,
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

      let tokenData: unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let finalizedSdkToken: SdkToken<any> | null = null;

      if (payload.sourceToken && payload.transferTx) {
        // Sphere wallet format - needs finalization for PROXY addresses
        console.log('[Payments] Received Sphere wallet format transfer');
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

        // Check if this is a PROXY address transfer (needs finalization)
        const recipientAddress = transferTx.data.recipient;
        const addressScheme = recipientAddress.scheme;

        if (addressScheme === AddressScheme.PROXY) {
          // Need to finalize with nametag token
          if (!this.nametag?.token) {
            console.error('[Payments] Cannot finalize PROXY transfer - no nametag token. Token rejected.');
            return; // Reject token - cannot spend without finalization
          }
          {
            try {
              const nametagToken = await SdkToken.fromJSON(this.nametag.token);
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

              const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const trustBase = (this.deps!.oracle as any).getTrustBase?.();

              if (!stClient || !trustBase) {
                console.error('[Payments] Cannot finalize - missing state transition client or trust base. Token rejected.');
                return; // Reject token - cannot spend without finalization
              }

              finalizedSdkToken = await stClient.finalizeTransaction(
                trustBase,
                sourceToken,
                recipientState,
                transferTx,
                [nametagToken]
              );
              tokenData = finalizedSdkToken.toJSON();
              this.log('Token finalized successfully');
            } catch (finalizeError) {
              console.error('[Payments] Finalization failed:', finalizeError);
              return; // Reject token - cannot spend without finalization
            }
          }
        } else {
          // Direct address - finalize to generate local state for tracking
          this.log('Finalizing DIRECT address transfer for state tracking...');
          try {
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

            const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const trustBase = (this.deps!.oracle as any).getTrustBase?.();

            if (!stClient || !trustBase) {
              this.log('Cannot finalize DIRECT transfer - missing client, using source token');
              tokenData = sourceTokenInput;
            } else {
              finalizedSdkToken = await stClient.finalizeTransaction(
                trustBase,
                sourceToken,
                recipientState,
                transferTx,
                []  // No nametag tokens needed for DIRECT
              );
              tokenData = finalizedSdkToken.toJSON();
              this.log('DIRECT transfer finalized successfully');
            }
          } catch (finalizeError) {
            this.log('DIRECT finalization failed, using source token:', finalizeError);
            tokenData = sourceTokenInput;
          }
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

      // Check if tombstoned
      const sdkTokenId = extractTokenIdFromSdkData(token.sdkData);
      const stateHash = extractStateHashFromSdkData(token.sdkData);
      if (sdkTokenId && stateHash && this.isStateTombstoned(sdkTokenId, stateHash)) {
        this.log(`Rejected tombstoned token ${sdkTokenId.slice(0, 8)}...`);
        return;
      }

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
      try {
        await provider.save(data);
      } catch (err) {
        console.error(`[Payments] Failed to save to provider ${id}:`, err);
      }
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

  private async createStorageData(): Promise<TxfStorageDataBase> {
    const tokens = Array.from(this.tokens.values());

    // Note: nametag is NOT passed here - it's saved separately via saveNametagToFileStorage()
    // as nametag-{name}.json to avoid duplication in storage
    return await buildTxfStorageData(
      tokens,
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

    // Load tokens
    this.tokens.clear();
    for (const token of parsed.tokens) {
      this.tokens.set(token.id, token);
    }

    // Load other data
    this.tombstones = parsed.tombstones;
    this.archivedTokens = parsed.archivedTokens;
    this.forkedTokens = parsed.forkedTokens;
    this.nametag = parsed.nametag;
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
