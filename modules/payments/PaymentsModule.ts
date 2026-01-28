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
import { STORAGE_KEYS } from '../../constants';
import {
  tokenToTxf,
  getCurrentStateHash,
  buildTxfStorageData,
  parseTxfStorageData,
} from '../../serialization/txf-serializer';

// SDK imports for token parsing and transfers
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { TokenId } from '@unicitylabs/state-transition-sdk/lib/token/TokenId';
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import { TransferTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import { ProxyAddress } from '@unicitylabs/state-transition-sdk/lib/address/ProxyAddress';
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
  amount: string;
  tokenId?: string;
}

/**
 * Parse token info from SDK token data or TXF JSON
 */
async function parseTokenInfo(tokenData: unknown): Promise<ParsedTokenInfo> {
  const defaultInfo: ParsedTokenInfo = {
    coinId: 'ALPHA',
    symbol: 'ALPHA',
    name: 'Alpha Token',
    amount: '0',
  };

  try {
    // If it's a string, try to parse as JSON
    const data = typeof tokenData === 'string' ? JSON.parse(tokenData) : tokenData;

    // Try to create SDK token and convert to JSON to extract data
    try {
      const sdkToken = await SdkToken.fromJSON(data);
      const tokenJson = sdkToken.toJSON() as unknown as Record<string, unknown>;

      // Try to get token ID
      if (sdkToken.id) {
        defaultInfo.tokenId = sdkToken.id.toString();
      }

      // Extract coin data from the JSON representation
      const genesisData = tokenJson.genesis as Record<string, unknown> | undefined;
      if (genesisData?.data) {
        const gData = genesisData.data as Record<string, unknown>;
        if (gData.coinData && typeof gData.coinData === 'object') {
          const coinEntries = Object.entries(gData.coinData as Record<string, unknown>);
          if (coinEntries.length > 0) {
            const [coinId, amount] = coinEntries[0];
            return {
              coinId,
              symbol: coinId,
              name: `${coinId} Token`,
              amount: String(amount),
              tokenId: defaultInfo.tokenId,
            };
          }
        }
      }
    } catch {
      // SDK parsing failed, try manual extraction
    }

    // Manual extraction from TXF format
    if (data.genesis?.data) {
      const genesis = data.genesis.data;
      if (genesis.coinData) {
        // Extract from coinData structure
        const coinEntries = Object.entries(genesis.coinData);
        if (coinEntries.length > 0) {
          const [coinId, amount] = coinEntries[0] as [string, unknown];
          return {
            coinId,
            symbol: coinId,
            name: `${coinId} Token`,
            amount: String(amount),
            tokenId: genesis.tokenId,
          };
        }
      }
      if (genesis.tokenId) {
        defaultInfo.tokenId = genesis.tokenId;
      }
    }

    // Try to extract from state if available
    if (data.state?.coinData) {
      const coinEntries = Object.entries(data.state.coinData);
      if (coinEntries.length > 0) {
        const [coinId, amount] = coinEntries[0] as [string, unknown];
        return {
          coinId,
          symbol: coinId,
          name: `${coinId} Token`,
          amount: String(amount),
          tokenId: defaultInfo.tokenId,
        };
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

    // Initialize L1 sub-module with chain code and addresses (if enabled)
    if (this.l1) {
      this.l1.initialize({
        identity: deps.identity,
        chainCode: deps.chainCode,
        addresses: deps.l1Addresses,
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

    // Load from key-value storage
    const data = await this.deps!.storage.get(STORAGE_KEYS.TOKENS);
    if (data) {
      try {
        const parsed = JSON.parse(data);

        // Load tokens
        const tokens = parsed.tokens as Token[] || [];
        this.tokens.clear();
        for (const token of tokens) {
          this.tokens.set(token.id, token);
        }

        // Load tombstones
        if (Array.isArray(parsed.tombstones)) {
          this.tombstones = parsed.tombstones.filter(
            (t: unknown) =>
              typeof t === 'object' && t !== null &&
              typeof (t as TombstoneEntry).tokenId === 'string' &&
              typeof (t as TombstoneEntry).stateHash === 'string'
          );
        }

        // Load archived tokens
        if (parsed.archivedTokens && typeof parsed.archivedTokens === 'object') {
          this.archivedTokens = new Map(Object.entries(parsed.archivedTokens));
        }

        // Load forked tokens
        if (parsed.forkedTokens && typeof parsed.forkedTokens === 'object') {
          this.forkedTokens = new Map(Object.entries(parsed.forkedTokens));
        }

        // Load nametag
        if (parsed.nametag) {
          this.nametag = parsed.nametag;
        }

        this.log(`Loaded ${this.tokens.size} tokens, ${this.tombstones.length} tombstones, ${this.archivedTokens.size} archived`);
      } catch (err) {
        console.error('[Payments] Failed to parse stored data:', err);
      }
    }

    // Load transaction history
    const historyData = await this.deps!.storage.get(STORAGE_KEYS.TRANSACTION_HISTORY);
    if (historyData) {
      try {
        this.transactionHistory = JSON.parse(historyData);
      } catch {
        this.transactionHistory = [];
      }
    }

    // Load pending transfers
    const pending = await this.deps!.storage.get(STORAGE_KEYS.PENDING_TRANSFERS);
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

      // Select tokens for amount
      const tokensToSend = this.selectTokens(request.coinId, BigInt(request.amount));
      if (tokensToSend.length === 0) {
        throw new Error('Insufficient balance');
      }

      result.tokens = tokensToSend;

      // Mark as transferring
      for (const token of tokensToSend) {
        token.status = 'transferring';
        this.tokens.set(token.id, token);
      }

      // Save to outbox for recovery
      await this.saveToOutbox(result, recipientPubkey);

      // Submit to aggregator
      result.status = 'submitted';

      for (const token of tokensToSend) {
        // Create SDK transfer commitment
        const commitment = await this.createSdkCommitment(token, recipientAddress, signingService);

        // Get state transition client from oracle provider
        const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;

        if (!stClient) {
          throw new Error('State transition client not available. Oracle provider must implement getStateTransitionClient()');
        }

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

        // Parse SDK token for Nostr payload
        const tokenData = token.sdkData
          ? (typeof token.sdkData === 'string' ? JSON.parse(token.sdkData) : token.sdkData)
          : token;
        const sdkToken = await SdkToken.fromJSON(tokenData);

        // Build payload for Nostr delivery (Sphere wallet format)
        // Send via transport (Nostr) - use Sphere-compatible format
        await this.deps!.transport.sendTokenTransfer(recipientPubkey, {
          sourceToken: JSON.stringify(sdkToken.toJSON()),
          transferTx: JSON.stringify(transferTx.toJSON()),
          memo: request.memo,
        } as unknown as import('../../transport').TokenTransferPayload);

        this.log(`Token ${token.id} transferred, txHash: ${result.txHash}`);
      }

      result.status = 'delivered';

      // Remove sent tokens (creates tombstones)
      const recipientNametag = request.recipient.startsWith('@') ? request.recipient.slice(1) : undefined;
      for (const token of tokensToSend) {
        await this.removeToken(token.id, recipientNametag);
      }

      // Save state
      await this.save();
      await this.removeFromOutbox(result.id);

      result.status = 'completed';

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
      senderPubkey: transportRequest.senderPubkey,
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
      responderPubkey: transportResponse.responderPubkey,
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
        balances.set(key, {
          coinId: token.coinId,
          symbol: token.symbol,
          name: token.name,
          totalAmount: token.amount,
          tokenCount: 1,
          decimals: 8,
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
    this.log(`Added token ${token.id}, total: ${this.tokens.size}`);
    return true;
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
      STORAGE_KEYS.TRANSACTION_HISTORY,
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
  // Private: Token Selection
  // ===========================================================================

  private selectTokens(coinId: string, amount: bigint): Token[] {
    const available = this.getTokens({ coinId, status: 'confirmed' });
    available.sort((a, b) => {
      const diff = BigInt(b.amount) - BigInt(a.amount);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    });

    const selected: Token[] = [];
    let total = 0n;

    for (const token of available) {
      if (total >= amount) break;
      selected.push(token);
      total += BigInt(token.amount);
    }

    return total >= amount ? selected : [];
  }

  // ===========================================================================
  // Private: Transfer Operations
  // ===========================================================================

  private async resolveRecipient(recipient: string): Promise<string> {
    if (recipient.startsWith('@')) {
      const nametag = recipient.slice(1);
      const pubkey = await this.deps!.transport.resolveNametag?.(nametag);
      if (!pubkey) {
        throw new Error(`Nametag not found: ${nametag}`);
      }
      return pubkey;
    }
    return recipient;
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
   * Resolve recipient to IAddress
   */
  private async resolveRecipientAddress(recipient: string): Promise<IAddress> {
    // If it's a nametag, resolve via TokenId
    if (recipient.startsWith('@')) {
      const nametag = recipient.slice(1);
      const tokenId = await TokenId.fromNameTag(nametag);
      return ProxyAddress.fromTokenId(tokenId);
    }

    // If it's a pubkey, create proxy address from it
    const pubkeyBytes = new Uint8Array(
      recipient.match(/.{1,2}/g)!.map((byte) => parseInt(byte, 16))
    );
    const tokenId = new TokenId(pubkeyBytes.slice(0, 32));
    return ProxyAddress.fromTokenId(tokenId);
  }

  private async handleIncomingTransfer(transfer: IncomingTokenTransfer): Promise<void> {
    try {
      // Check payload format - Sphere wallet sends { sourceToken, transferTx }
      // SDK format is { token, proof }
      const payload = transfer.payload as unknown as Record<string, unknown>;

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

        const sourceToken = await SdkToken.fromJSON(sourceTokenInput);
        const transferTx = await TransferTransaction.fromJSON(transferTxInput);

        // Check if this is a PROXY address transfer (needs finalization)
        const recipientAddress = transferTx.data.recipient;
        const addressScheme = recipientAddress.scheme;

        if (addressScheme === AddressScheme.PROXY) {
          // Need to finalize with nametag token
          if (!this.nametag?.token) {
            console.warn('[Payments] Cannot finalize PROXY transfer - no nametag token');
            // Try to save without finalization
            tokenData = sourceTokenInput;
          } else {
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
                console.warn('[Payments] Cannot finalize - missing state transition client or trust base');
                tokenData = sourceTokenInput;
              } else {
                finalizedSdkToken = await stClient.finalizeTransaction(
                  trustBase,
                  sourceToken,
                  recipientState,
                  transferTx,
                  [nametagToken]
                );
                tokenData = finalizedSdkToken.toJSON();
                this.log('Token finalized successfully');
              }
            } catch (finalizeError) {
              console.error('[Payments] Finalization failed:', finalizeError);
              tokenData = sourceTokenInput;
            }
          }
        } else {
          // Direct address - no finalization needed
          tokenData = sourceTokenInput;
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
        senderPubkey: transfer.senderPubkey,
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
    const tokens = Array.from(this.tokens.values());

    const data = {
      tokens,
      tombstones: this.tombstones.length > 0 ? this.tombstones : undefined,
      archivedTokens: this.archivedTokens.size > 0
        ? Object.fromEntries(this.archivedTokens)
        : undefined,
      forkedTokens: this.forkedTokens.size > 0
        ? Object.fromEntries(this.forkedTokens)
        : undefined,
      nametag: this.nametag || undefined,
    };

    await this.deps!.storage.set(STORAGE_KEYS.TOKENS, JSON.stringify(data));
  }

  private async saveToOutbox(transfer: TransferResult, recipient: string): Promise<void> {
    const outbox = await this.loadOutbox();
    outbox.push({ transfer, recipient, createdAt: Date.now() });
    await this.deps!.storage.set(STORAGE_KEYS.OUTBOX, JSON.stringify(outbox));
  }

  private async removeFromOutbox(transferId: string): Promise<void> {
    const outbox = await this.loadOutbox();
    const filtered = outbox.filter((e) => e.transfer.id !== transferId);
    await this.deps!.storage.set(STORAGE_KEYS.OUTBOX, JSON.stringify(filtered));
  }

  private async loadOutbox(): Promise<Array<{ transfer: TransferResult; recipient: string; createdAt: number }>> {
    const data = await this.deps!.storage.get(STORAGE_KEYS.OUTBOX);
    return data ? JSON.parse(data) : [];
  }

  private async createStorageData(): Promise<TxfStorageDataBase> {
    const tokens = Array.from(this.tokens.values());

    return await buildTxfStorageData(
      tokens,
      {
        version: 1,
        address: this.deps!.identity.address,
        ipnsName: this.deps!.identity.ipnsName ?? '',
      },
      {
        nametag: this.nametag || undefined,
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
