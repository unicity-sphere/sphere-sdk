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
import { TokenSplitCalculator, type SplitPlan, type TokenWithAmount } from './TokenSplitCalculator';
import { TokenSplitExecutor } from './TokenSplitExecutor';
import { TokenReservationLedger } from './TokenReservationLedger';
import { SpendPlanner, SpendQueue, type ParsedTokenEntry, type ParsedTokenPool } from './SpendQueue';
import { NametagMinter, type MintNametagResult } from './NametagMinter';
import { CidRefStore, type CidRef } from '../../profile/cid-ref-store';
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
import { DEFAULT_ASSET_KINDS_WHEN_ABSENT } from '../../transport/transport-provider';
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
  txfToToken,
  getCurrentStateHash,
  buildTxfStorageData,
  parseTxfStorageData,
} from '../../serialization/txf-serializer';
import { TokenRegistry } from '../../registry';
import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';
import {
  narrowTransferMode,
  requireLegacyCoinSlot,
  type LegacyCoinTransferRequest,
} from './transfer/transfer-mode-shims';
import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
} from './transfer/conservative-sender';
import {
  sendInstantUxf,
  type InstantCommitResult,
  type InstantSenderDeps,
} from './transfer/instant-sender';
import {
  sendTxfUxf,
  type TxfCommitResult,
  type TxfFinalization,
  type TxfSenderDeps,
} from './transfer/txf-sender';
import { classifyToken as classifyTokenLike } from './transfer/classify-token';
import {
  IngestWorkerPool,
  type IngestWorkerPoolOptions,
  type UxfV1Payload,
  type ProcessTokenFn,
} from './transfer/ingest-worker-pool';
import { ReplayLRU } from './transfer/replay-lru';
import { PerTokenMutex } from '../../profile/per-token-mutex';
// T.5.D — operator escape hatch (`importInclusionProof` +
// `revalidateCascadedChildren`). Class types only; the wiring layer
// (Sphere bootstrap) constructs the runtime instances and installs them
// via the dedicated install* methods below.
import {
  InclusionProofImporter,
  type ImportInclusionProofCallOptions,
  type ImportProofResult,
  type ImportableInclusionProof,
} from './transfer/import-inclusion-proof';
import {
  RevalidateCascadedRunner,
  type RevalidationResult,
} from './transfer/revalidate-cascaded';
// Phase 8 steelman post-cutover — sending-recovery worker. The bootstrap
// layer (Sphere) wires an instance via `installSendingRecoveryWorker()`;
// the module starts/stops it gated on `features.recoveryWorker`.
import { SendingRecoveryWorker } from './transfer/sending-recovery-worker';
// Phase 9.6.D — sender-side §6.1 finalization worker. Auto-installed in
// `initialize()` when `features.finalizationWorker` is true (default-ON
// when `senderUxf` is true). Consumer-installed workers (via
// `installFinalizationWorkerSender()`) win over the auto-installed one.
import {
  FinalizationWorkerSender,
  CountingSemaphore,
  type FinalizationAggregatorClient,
  type FinalizationOutboxWriter,
  type RequestContextResolver,
  type RequestContext,
  type SubmitOutcome,
  type PollOutcome,
} from './transfer/finalization-worker-sender';
import { ManifestCas, type MinimalManifestStorage } from '../../profile/manifest-cas';
import { contentHash, type ContentHash } from '../../uxf/types';
import { isLegacyTokenTransferPayload } from '../../types/uxf-transfer';
import type { UxfTransferOutboxEntry } from '../../types/uxf-outbox';
import {
  resolveSenderInfoViaBinding,
  type ReresolvedNametagSource,
} from './transfer/nametag-reresolver';

/**
 * Narrow guard for the UXF v1.0 wire shapes accepted by the
 * {@link IngestWorkerPool}. Legacy shapes have no `kind` field; v1.0
 * shapes carry `kind: 'uxf-car' | 'uxf-cid'`.
 */
function isUxfV1Payload(value: unknown): value is UxfV1Payload {
  if (value === null || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'uxf-car' || kind === 'uxf-cid';
}
import { parseInvoiceMemoForOnChain } from '../accounting/memo.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes as fromHex } from '../../core/hex';
// `profile/types` is a pure types + constants module with zero runtime
// dependencies — safe to import statically in every build. The previous
// dynamic import was motivated by a bundle-size concern that didn't apply
// here; it silently swallowed import errors in consumer builds lacking
// matching bundler rules and made Profile-mode data load paths fragile.
import { computeAddressId } from '../../profile/types.js';

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
  CombinedTransferBundleV6,
  DirectTokenEntry,
} from '../../types/instant-split';
import { isInstantSplitBundle, isInstantSplitBundleV5, isCombinedTransferBundleV6 } from '../../types/instant-split';

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
import { TransferTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransactionData';
import type { IAddress } from '@unicitylabs/state-transition-sdk/lib/address/IAddress';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase';

// =============================================================================
// Transaction History Entry
// =============================================================================

/**
 * Public history entry type — re-exported from the shared storage layer.
 * Single source of truth: {@link HistoryRecord} in `storage/storage-provider.ts`.
 */
export type TransactionHistoryEntry = import('../../storage').HistoryRecord;

// =============================================================================
// importTokens result types
// =============================================================================

/**
 * Outcome of a single token in `importTokens`. Codes are stable enums
 * suitable for switch-on-code logic in callers (CLI, scripting, UI).
 */
export type ImportAddedCode =
  /** Token was new to the wallet — fresh acquisition. */
  | 'added'
  /**
   * Lenient mode only: an active (confirmed or submitted) state of
   * the same genesis tokenId existed in the wallet and has been
   * archived by addToken's state-update path. The imported state is
   * now authoritative. Distinct from `'stale-record-replaced'` below.
   */
  | 'state-replaced'
  /**
   * Lenient mode only: the wallet already held a record for the same
   * genesis tokenId but its status was `'spent'` or `'invalid'` — the
   * prior entry was a dead bookkeeping record, not an active state.
   * Import simply resurrected the tokenId. UI should treat this as
   * effectively fresh ('added'-like) with no warning.
   */
  | 'stale-record-replaced';

export type ImportSkipCode =
  /** Exact (tokenId, stateHash) already in the wallet. */
  | 'duplicate'
  /** (tokenId, stateHash) was previously spent from this wallet. */
  | 'tombstoned'
  /**
   * Strict-mode only: tokenId is in the wallet at a DIFFERENT state
   * and we refuse to clobber that state from an import.
   */
  | 'genesis-exists'
  /** addToken returned false despite the pre-checks (race or unknown). */
  | 'unknown';

export type ImportRejectCode =
  /** TxfToken structure is invalid (missing fields, wrong types, etc.). */
  | 'malformed'
  /** addToken threw an unexpected error during the write path. */
  | 'add-failed';

/**
 * Discriminated union so `note` is structurally required on the
 * `'state-replaced'` and `'stale-record-replaced'` branches — consumers
 * don't need `!` assertions after switch-on-code.
 */
export type ImportAdded =
  | {
      readonly localId: string;
      readonly genesisTokenId: string;
      readonly code: 'added';
    }
  | {
      readonly localId: string;
      readonly genesisTokenId: string;
      readonly code: 'state-replaced' | 'stale-record-replaced';
      readonly note: string;
    };
export interface ImportSkipped {
  readonly genesisTokenId: string;
  readonly code: ImportSkipCode;
  readonly reason: string;
}
export interface ImportRejected {
  readonly genesisTokenId: string | null;
  readonly code: ImportRejectCode;
  readonly reason: string;
}
export interface ImportTokensResult {
  readonly added: ImportAdded[];
  readonly skipped: ImportSkipped[];
  readonly rejected: ImportRejected[];
}

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

function parseSdkDataCached(sdkData: string): { tokenId: string | null; stateHash: string } {
  const cached = sdkDataCache.get(sdkData);
  if (cached) return cached;

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

  const entry = { tokenId, stateHash };
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
function extractTokenIdFromSdkData(sdkData: string | undefined): string | null {
  if (!sdkData) return null;
  return parseSdkDataCached(sdkData).tokenId;
}

/**
 * Extract state hash from sdkData/jsonData
 */
function extractStateHashFromSdkData(sdkData: string | undefined): string {
  if (!sdkData) return '';
  return parseSdkDataCached(sdkData).stateHash;
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

// Steelman³⁵: fromHex consolidated to core/hex.ts (top-of-file import).

/**
 * Compute a deterministic dedup key for a pending-mint (pre-finalization)
 * token, whose `getCurrentStateHash` is empty because the aggregator
 * hasn't returned an inclusion proof yet.
 *
 * We hash a canonical JSON encoding of the GENESIS DATA so the same
 * genesis always produces the same key. JSON.stringify (not pipe-
 * delimiting) ensures that any future field additions, `null` vs
 * `undefined` vs `''` distinctions, and field-values containing
 * special characters don't cause cross-genesis collisions.
 *
 * The returned key is prefixed `pending-` so it can never collide
 * with a real state hash (which is always a 64-hex SHA-256).
 *
 * @param txf - A TxfToken (typically the incoming import candidate).
 * @returns `pending-<64 hex>` — deterministic per genesis content.
 */
function pendingMintDedupKey(txf: {
  genesis?: {
    data?: {
      tokenId?: string;
      tokenType?: string;
      salt?: string;
      recipient?: string | null;
      tokenData?: string | null;
      recipientDataHash?: string | null;
    };
  };
}): string {
  const d = txf.genesis?.data ?? {};
  // Canonical JSON (fixed field order) preserves null-vs-undefined-vs-''
  // distinctions and is robust against any special characters in field
  // values. We explicitly list the fields rather than stringifying `d`
  // to avoid unrelated keys on `d` (e.g., future SDK additions) changing
  // the key for tokens already minted against the old schema.
  const canonical = JSON.stringify([
    d.tokenId ?? null,
    d.tokenType ?? null,
    d.salt ?? null,
    d.recipient ?? null,
    d.tokenData ?? null,
    d.recipientDataHash ?? null,
  ]);
  const digest = sha256(new TextEncoder().encode(canonical));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return 'pending-' + hex;
}

/**
 * Given an incoming TxfToken, return the dedup key to use for
 * duplicate detection in `importTokens`:
 *   - the token's CURRENT state hash when available (via
 *     `getCurrentStateHash`, which looks at the last transaction's
 *     `newStateHash` first, then authenticator, then genesis)
 *   - the pending-mint fallback otherwise
 *
 * Using `getCurrentStateHash` rather than reading only the genesis
 * path is load-bearing: a token that has been transferred has a
 * genesis hash that NEVER changes, but a current state hash that
 * tracks the latest transaction. If we keyed on genesis, two
 * different live states of the same token would collide as
 * "duplicate" and valid state updates would be silently dropped
 * on re-import.
 *
 * The return is a non-empty opaque string suitable for equality
 * comparison. Different shapes (real vs pending) never collide
 * because the pending variant is prefixed.
 */
function effectiveDedupKey(
  txf: Parameters<typeof pendingMintDedupKey>[0] & Parameters<typeof getCurrentStateHash>[0],
): string {
  const stateHash = getCurrentStateHash(txf as TxfToken) ?? '';
  if (stateHash) return stateHash;
  return pendingMintDedupKey(txf);
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

/**
 * UXF Inter-Wallet Transfer feature flags (T.2.D.1).
 *
 * Controls staged enablement of the UXF send/receive pipeline. T.8.D
 * part 1 of 2 (production cutover, this release) flipped every flag's
 * default from `false` → `true`. Legacy paths remain available by
 * passing explicit `features: { senderUxf: false, ... }`; legacy code
 * removal is T.8.D part 2 of 2 (gated on testnet soak).
 *
 * Cross-version interop: a sender with `senderUxf: true` emits UXF v1.0
 * wire shapes (`uxf-cid` / `uxf-car`); a receiver running an older SDK
 * without UXF ingest can NOT decode them. Pin a shared SDK version
 * across senders/receivers during the transition, OR set the relevant
 * flag(s) to `false` explicitly to preserve the legacy path.
 *
 * See `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` §1 "Feature flag config" and
 * §T.8.D production cutover.
 */
export interface UxfTransferFeatures {
  /** T.2.D.1 / T.5.A — when `true` (default), route conservative-mode
   *  AND instant-mode (the public default) sends through the UXF
   *  wire-format orchestrators. Set `false` to fall through to the
   *  legacy single-token TXF path (rollback escape hatch). */
  readonly senderUxf?: boolean;
  /**
   * Phase 8 steelman post-cutover — when `true` (default), instantiate
   * and start `SendingRecoveryWorker` in {@link PaymentsModule.initialize};
   * stop it in {@link PaymentsModule.destroy}. The worker periodically
   * re-publishes outbox entries left in `'sending'` after a crash
   * between OrbitDB commit and Nostr publish ack (closes the gap
   * documented in `conservative-sender.ts` lines 212 / 886 / 903).
   *
   * The worker is a no-op until a republish hook is injected by the
   * bootstrap layer (`installSendingRecoveryRepublishHook`); the flag
   * does NOT itself drive any send traffic. Set `false` to suppress
   * worker installation entirely (e.g. for unit tests that count timers).
   */
  readonly recoveryWorker?: boolean;
  /**
   * Phase 9.6.D — when `true` (default when `senderUxf` is on),
   * auto-install and start a {@link FinalizationWorkerSender} in
   * {@link PaymentsModule.initialize} so instant-mode sends drive the
   * §6.1 finalization cycle and emit `transfer:confirmed` once the
   * aggregator anchors the commitment. Set `false` to suppress the
   * auto-install (e.g. for unit tests that mock the aggregator or do
   * not need `transfer:confirmed`). Consumer-installed workers (via
   * {@link PaymentsModule.installFinalizationWorkerSender}) win over
   * the auto-installed one and are unaffected by this flag.
   */
  readonly finalizationWorker?: boolean;
  /**
   * T.3.E — when `true` (default), route incoming UXF v1.0 bundles
   * (`kind` of `'uxf-car'` or `'uxf-cid'`) through the
   * {@link IngestWorkerPool} (§5.0 N parallel workers + W7 per-tokenId
   * fairness + W23 bundle-internal sequential). Set `false` to fall
   * back to the legacy single-threaded `handleIncomingTransfer` path.
   * Legacy V4/V5/V6 shapes (no `kind` field) bypass the pool regardless
   * of this flag — they remain on the legacy adapter path.
   */
  readonly recipientUxf?: boolean;
  /**
   * T.7.B — when `true` (default) AND a legacy-shape adapter has been
   * installed via {@link installLegacyShapeAdapter}, every inbound
   * legacy event (Sphere TXF, V6 `COMBINED_TRANSFER`, V5/V4
   * `INSTANT_SPLIT`, SDK legacy `{token, proof}`) is decomposed into N
   * synthetic disposition records and written through the T.3.C
   * disposition writer alongside the existing legacy storage path.
   * Instant-TXF arrivals (any tx with `inclusionProof: null`) are
   * enqueued on the recipient finalization queue (T.5.C) — same
   * chain-mode semantics as instant-UXF.
   *
   * Default-ON is REQUIRED for cross-version interop with senders that
   * still emit legacy wire shapes (i.e. anyone who has not yet upgraded
   * to T.8.D-cutover SDK). Set `false` only if you are confident no
   * peer can send legacy shapes (legacy storage path still runs as a
   * fallback regardless). Independent of {@link recipientUxf}: a wallet
   * MAY enable UXF v1.0 ingest without legacy adaptation, or vice
   * versa. See §10.2 single-pipeline convergence guarantee.
   */
  readonly recipientLegacyAdapter?: boolean;
}

/**
 * T.7.B — legacy-shape adapter runner. Owned by the bootstrap layer
 * (Sphere) and installed via {@link PaymentsModule.installLegacyShapeAdapter}.
 *
 * The runner is the single injection point that captures every
 * dependency `adaptLegacyShape` needs (predicate evaluator,
 * authenticator verifier, proof verifier, oracle, manifest reader,
 * finalization-queue enqueuer, disposition writer). Keeping the
 * dependency graph behind a single interface avoids bloating
 * `PaymentsModuleDependencies` with seven new fields.
 *
 * **Contract**:
 *  - `processLegacy` MUST NOT throw under normal operation; failures
 *    are routed into the disposition pipeline as `STRUCTURAL_INVALID`
 *    records by the adapter itself. A throw out of `processLegacy`
 *    is logged by the module and treated as a no-op for that event.
 *  - The runner is responsible for routing every returned
 *    `DispositionRecord` through the T.3.C disposition writer; the
 *    module does NOT inspect the records itself.
 *  - The runner SHOULD enqueue instant-TXF entries on the recipient
 *    finalization queue (T.5.C) when the adapter detects them.
 */
export interface LegacyShapeAdapterRunner {
  /**
   * Process one inbound legacy event end-to-end. The implementation
   * builds a `LegacyShapeAdapterInput`, calls `adaptLegacyShape`, and
   * routes the resulting `DispositionRecord[]` through the T.3.C
   * writer.
   *
   * @param payload   The decoded legacy payload (one of four shapes).
   * @param senderTransportPubkey  The AUTHENTICATED Nostr signing
   *                               pubkey of the event author.
   */
  processLegacy(
    payload: unknown,
    senderTransportPubkey: string,
  ): Promise<void>;
}

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
  /** UXF Inter-Wallet Transfer feature flags. Default: all ON
   *  (T.8.D part 1 of 2). Pass explicit `false` per-flag to fall back
   *  to the legacy code path for that surface. */
  features?: UxfTransferFeatures;
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
  /** Set of disabled provider IDs — disabled providers are skipped during sync/save */
  disabledProviderIds?: ReadonlySet<string>;
  /**
   * Optional CID-reference store for offloading fat KV values (pending V5
   * tokens, V5 outbox) to IPFS. When absent, those values fall back to
   * inline JSON in storage.set — acceptable for legacy wallets and tests
   * but unbounded growth for heavy users. See PROFILE-CID-REFERENCES.md.
   */
  cidRefStore?: CidRefStore;
}

// =============================================================================
// Implementation
// =============================================================================

export class PaymentsModule {
  private readonly moduleConfig: Omit<Required<PaymentsModuleConfig>, 'l1' | 'features'>;
  /**
   * UXF Inter-Wallet Transfer feature flags (T.2.D.1).
   * Frozen at construction time. Defaults (T.8.D part 1 of 2): every flag
   * ON — `senderUxf=true` makes `send({transferMode:'instant'})` route
   * through the UXF instant-sender; legacy paths remain available by
   * passing explicit `features: { senderUxf: false, ... }`. Legacy
   * removal is T.8.D part 2 of 2 (gated on testnet soak).
   */
  private readonly features: Required<UxfTransferFeatures>;
  private deps: PaymentsModuleDependencies | null = null;

  /**
   * Recipient-side ingest worker pool (T.3.E §5.0).
   *
   * When `features.recipientUxf === true` AND a pool has been wired via
   * {@link installIngestWorkerPool}, incoming UXF v1.0 bundles
   * (`kind: 'uxf-car' | 'uxf-cid'`) are enqueued onto this pool's
   * bounded queue and dispatched across N=16 parallel workers. Legacy
   * shapes (V4/V5/V6/`{token,proof}`) bypass the pool regardless of
   * the feature flag.
   *
   * `null` until the caller (Sphere bootstrap) installs a pool — the
   * pool itself depends on the disposition engine + writer wiring,
   * which is built one layer up. Default `null` means UXF v1.0 bundles
   * are dropped with a warning when `recipientUxf` is on but no pool
   * is installed (graceful degradation — the flag should not silently
   * route to a stub).
   */
  private ingestPool: IngestWorkerPool | null = null;

  /**
   * Recipient-side legacy-shape adapter runner (T.7.B).
   *
   * Invoked by `handleIncomingTransfer` for every event whose payload
   * matches one of the four §3.4 legacy shapes (Sphere TXF, V6
   * `COMBINED_TRANSFER`, V5/V4 `INSTANT_SPLIT`, SDK legacy `{token,
   * proof}`). The runner is responsible for ALL of:
   *  - decomposing the event into per-token entries,
   *  - calling `adaptLegacyShape` with all required disposition-engine
   *    hooks pre-wired,
   *  - routing each returned `DispositionRecord` through the T.3.C
   *    {@link DispositionWriter},
   *  - enqueueing instant-TXF entries on the recipient finalization
   *    queue (T.5.C).
   *
   * `null` until the bootstrap layer (Sphere) installs a runner via
   * {@link installLegacyShapeAdapter}. When `null` AND
   * `features.recipientLegacyAdapter === true`, the module logs a
   * warning per arrival but does NOT route through the adapter (graceful
   * degradation: the pre-existing legacy storage path still runs).
   */
  private legacyShapeAdapterRunner: LegacyShapeAdapterRunner | null = null;

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

  // NOSTR-FIRST proof polling (background proof verification)
  private proofPollingJobs: Map<string, ProofPollingJob> = new Map();
  private proofPollingInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly PROOF_POLLING_INTERVAL_MS = 2000;  // Poll every 2s
  private static readonly PROOF_POLLING_MAX_ATTEMPTS = 30;   // Max 30 attempts (~60s)

  // Periodic retry for resolveUnconfirmed (V5 lazy finalization)
  private resolveUnconfirmedTimer: ReturnType<typeof setInterval> | null = null;
  private static readonly RESOLVE_UNCONFIRMED_INTERVAL_MS = 10_000; // Retry every 10s

  // Guard: ensure load() completes before processing incoming bundles
  private loadedPromise: Promise<void> | null = null;
  private loaded = false;

  // Persistent dedup: tracks splitGroupIds that have been fully processed.
  // Survives page reloads via KV storage so Nostr re-deliveries are ignored
  // even when the confirmed token's in-memory ID differs from v5split_{id}.
  private processedSplitGroupIds: Set<string> = new Set();

  // Persistent dedup: tracks V6 combined transfer IDs that have been processed.
  private processedCombinedTransferIds: Set<string> = new Set();

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

    // T.8.D part 1 of 2 — UXF feature flags now default ON (production
    // cutover, no legacy code path removal). The four flags moved from
    // default-OFF → default-ON in this release; legacy paths remain
    // available by passing explicit `features: { senderUxf: false, ... }`
    // and will be removed in T.8.D part 2 of 2 after testnet soak.
    //
    // Cross-version interop caveat: a sender with `senderUxf: true` emits
    // UXF v1.0 wire shapes (`uxf-cid` / `uxf-car`); a receiver running an
    // older SDK without UXF ingest will not be able to decode them. Pin a
    // shared SDK version across senders/receivers during the transition,
    // OR set `senderUxf: false` explicitly to preserve legacy wire-shape
    // emission. See `docs/uxf/UXF-TRANSFER-IMPL-PLAN.md` §T.8.D.
    //
    // Frozen so accidental mutation can't toggle behavior at runtime.
    this.features = Object.freeze({
      // T.5.A — instant-mode UXF sender. Default-ON: `payments.send({})`
      // (or `transferMode: 'instant'`) routes through the new UXF
      // instant-sender, emitting a `uxf-cid` bundle by default.
      senderUxf: config?.features?.senderUxf ?? true,
      // T.3.E — recipient-side ingest worker pool. Default-ON: incoming
      // UXF v1.0 bundles (`kind: 'uxf-car' | 'uxf-cid'`) enqueue onto the
      // bounded pool. Legacy V4/V5/V6/`{token,proof}` shapes still
      // bypass the pool regardless of this flag.
      recipientUxf: config?.features?.recipientUxf ?? true,
      // T.7.B — legacy-shape adapter routing flag. Default-ON for
      // cross-version interop with old senders: inbound legacy events
      // (Sphere TXF / V6 / V5 / SDK legacy) are decomposed into
      // `DispositionRecord` synthetic entries and routed through the
      // T.3.C disposition writer. MUST stay ON if any peer in the
      // transition window emits legacy wire shapes.
      recipientLegacyAdapter: config?.features?.recipientLegacyAdapter ?? true,
      // Phase 8 steelman post-cutover — sending-recovery worker.
      // Default-ON: catches outbox entries stuck in `'sending'` after a
      // crash between OrbitDB commit and Nostr publish ack and re-publishes
      // them idempotently. The worker still no-ops until a republish hook
      // is wired by the bootstrap layer.
      recoveryWorker: config?.features?.recoveryWorker ?? true,
      // Phase 9.6.D — sender-side §6.1 finalization worker. Default-ON
      // when senderUxf is on: drives instant-mode sends through the full
      // submit/poll cycle so `transfer:confirmed` fires once the
      // aggregator anchors the commitment. Flip `false` to suppress the
      // auto-install (e.g. timer-sensitive unit tests).
      finalizationWorker: config?.features?.finalizationWorker ?? true,
    });

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
  getConfig(): Omit<Required<PaymentsModuleConfig>, 'l1' | 'features'> {
    return this.moduleConfig;
  }

  /**
   * Read-only accessor for the UXF Inter-Wallet Transfer feature flags
   * (T.2.D.1). Useful for tests and downstream tooling that needs to
   * verify the configured rollout state.
   */
  getFeatures(): Readonly<Required<UxfTransferFeatures>> {
    return this.features;
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

    // Stop all background timers/jobs from previous address context.
    // Without this, proof polling, resolveUnconfirmed intervals, and
    // pending response resolvers continue running after address switch
    // and may call save() in the new address's storage context.
    this.stopProofPolling();
    this.proofPollingJobs.clear();
    this.stopResolveUnconfirmedPolling();
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

    // Phase 8 steelman post-cutover — start the sending-recovery worker
    // when both (a) the gate is on AND (b) a worker has been installed
    // by the bootstrap layer. After T.8.D part 1 of 2 the gate defaults
    // to `true`; the start is still no-op when no worker is installed
    // (forensic warning omitted intentionally — the bootstrap is the
    // single install point and a missing install is a deployment-config
    // bug, not a hot path). Tests that count timers can opt out via
    // `features: { recoveryWorker: false }`.
    if (this.features.recoveryWorker && this.sendingRecoveryWorker !== null) {
      this.sendingRecoveryWorker.start();
    }

    // T.3.E — auto-install a default IngestWorkerPool when recipientUxf
    // is on AND the bootstrap layer has not already wired a custom pool.
    //
    // After T.8.D part 1 flipped features.recipientUxf to default-ON,
    // incoming UXF v1 bundles routed to the gate at handleIncomingTransfer
    // line 7506 found `this.ingestPool === null` and fell through to the
    // legacy arm, which does not recognize `kind: 'uxf-car'/'uxf-cid'`
    // wire shapes — every UXF event was dropped with "Unknown transfer
    // payload format".
    //
    // The default processToken closure mirrors the legacy receive arm
    // (lines ~7750-7800): assemble → validateToken → parseTokenInfo →
    // build Token → addToken → addToHistory → emit transfer:incoming.
    // It captures `this` via closure so it shares all the same per-address
    // state as the rest of the module.
    //
    // Consumer-installed pools (via installIngestWorkerPool()) win: the
    // check `!this.ingestPool` preserves that contract. Calling
    // installIngestWorkerPool() AFTER initialize() replaces the
    // auto-installed pool (existing idempotent replace logic handles it).
    if (this.features.recipientUxf && !this.ingestPool) {
      const lru = new ReplayLRU();
      const mutex = new PerTokenMutex();

      const processToken: ProcessTokenFn = async (tokenRoot, verified, ctx) => {
        // Guard: only process token-roots that are CLAIMED for this recipient.
        // The pool dispatcher passes BOTH verified.claimedTokens AND
        // verified.advisoryUnclaimedRoots to every processToken call (by
        // design — consumer-installed pools may want to inspect advisory roots
        // for telemetry or §5.4 / §B' replica-merge purposes). The default
        // wallet-receive closure must NOT attempt pkg.assemble() on advisory
        // roots — they have no manifest entry in the recipient's view of the
        // bundle (only the sender's claimed targets are written into the
        // manifest), so assemble() would throw UxfError TOKEN_NOT_FOUND. The
        // oracle would also correctly reject them as invalid for this recipient.
        //
        // Build the claim set once per call from verified.claimedTokens; this
        // is O(N) where N = number of claimed tokens (typically 1–5), acceptable
        // inside the per-tokenId mutex.
        const claimedTokenIds = new Set(verified.claimedTokens.map((r) => r.tokenId));
        // [DIAG-UXF-RECV] bundle-level: how many tokens are claimed for this recipient?
        logger.debug('Payments', '[DIAG-UXF-RECV] processToken entry', {
          bundleCid: ctx.bundleCid.slice(0, 16),
          claimedCount: verified.claimedTokens.length,
          claimedTokenIds: verified.claimedTokens.map((r) => r.tokenId.slice(0, 16)),
          thisTokenId: tokenRoot.tokenId.slice(0, 16),
          isClaimed: claimedTokenIds.has(tokenRoot.tokenId),
        });
        if (!claimedTokenIds.has(tokenRoot.tokenId)) {
          logger.debug(
            'Payments',
            `UXF processToken: skipping advisoryUnclaimedRoot ${tokenRoot.tokenId.slice(0, 16)} — not for this recipient`,
          );
          return;
        }

        try {
          // 1. Reassemble the sender's token JSON from the verified bundle.
          //    The sender packages the bundle with the SOURCE token's state
          //    (the sender's predicate), not the recipient's.  The last
          //    transaction in the bundle IS the transfer-to-recipient tx,
          //    but the top-level `state` field still points at the sender.
          //    SdkToken.verify(trustBase) rejects this because
          //      state.predicate → sender address
          //      ≠ transactions[-1].data.recipient → recipient address.
          //    We must construct the recipient's UnmaskedPredicate + state
          //    and call finalizeTransferToken() (conservative) or patch
          //    the state JSON and store as pending (instant).
          const assembledJson = verified.pkg.assemble(tokenRoot.tokenId) as Record<string, unknown>;
          // [DIAG-UXF-RECV] assemble succeeded
          logger.debug('Payments', '[DIAG-UXF-RECV] pkg.assemble succeeded', {
            tokenId: tokenRoot.tokenId.slice(0, 16),
            txCount: Array.isArray(assembledJson.transactions) ? (assembledJson.transactions as unknown[]).length : 'n/a',
          });

          // Decide whether recipient-side finalization is needed.
          // A token with no transfer transactions cannot be finalized (and
          // is unlikely in production, but guard for tests / edge cases).
          const txArray = Array.isArray(assembledJson.transactions)
            ? (assembledJson.transactions as Record<string, unknown>[])
            : [];

          // Working variables updated by the finalization block.
          let tokenData: unknown = assembledJson;
          let tokenStatus: Token['status'] = 'confirmed';

          if (txArray.length > 0) {
            const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const trustBase = (this.deps!.oracle as any).getTrustBase?.();
            const lastTxJson = txArray.at(-1) as Record<string, unknown> | undefined;
            const hasNullProof = lastTxJson?.inclusionProof === null;

            if (stClient && trustBase && lastTxJson?.data != null) {
              try {
                // Parse TransferTransactionData to get the salt.
                // This works for BOTH conservative (proof present) and
                // instant (inclusionProof: null) because we only parse
                // the `data` sub-object, not the full TransferTransaction.
                const txData = await TransferTransactionData.fromJSON(lastTxJson.data);
                const transferSalt = txData.salt;

                // Assemble the source token at state N-1 (genesis + all
                // transactions EXCEPT the final transfer-to-us).
                const txCount = verified.pkg.transactionCount(tokenRoot.tokenId);
                const sourceTokenJson = verified.pkg.assembleAtState(
                  tokenRoot.tokenId,
                  txCount - 1,
                );
                const sourceToken = await SdkToken.fromJSON(sourceTokenJson);

                // Construct recipient UnmaskedPredicate and TokenState.
                const signingService = await this.createSigningService();
                const recipientPredicate = await UnmaskedPredicate.create(
                  sourceToken.id,
                  sourceToken.type,
                  signingService,
                  HashAlgorithm.SHA256,
                  transferSalt,
                );
                const recipientState = new TokenState(recipientPredicate, null);

                if (!hasNullProof) {
                  // 2a. Conservative path: all inclusion proofs are present.
                  //    Call the shared finalizeTransferToken helper which
                  //    mirrors the legacy receive arm (line ~7873).
                  //    This calls stClient.finalizeTransaction() to produce
                  //    a fully-verified SDK Token with the recipient's state.
                  const lastTx = await TransferTransaction.fromJSON(lastTxJson);
                  const finalizedToken = await this.finalizeTransferToken(
                    sourceToken,
                    lastTx,
                    stClient,
                    trustBase,
                  );
                  tokenData = finalizedToken.toJSON();
                  // tokenStatus remains 'confirmed'
                } else {
                  // 2b. Instant path: the last tx has inclusionProof: null.
                  //    TransferTransaction.fromJSON(null_proof) throws, so
                  //    we cannot call finalizeTransaction().  Instead:
                  //    - Patch the assembled JSON's `state` field with the
                  //      recipient's state (so the stored sdkData records
                  //      the correct owner predicate).
                  //    - Store as status='pending'; oracle validation is
                  //      deferred per spec §5.3 [E] (unfinalizedCount > 0).
                  //    The finalization worker (§5.5 / T.5.C) is responsible
                  //    for attaching the proof and re-running [B]/[E] once
                  //    the aggregator returns it.
                  tokenData = { ...assembledJson, state: recipientState.toJSON() };
                  tokenStatus = 'pending';
                }
              } catch (finalizeErr) {
                // If recipient-side finalization fails unexpectedly, fall
                // back to submitting the assembled JSON directly to the
                // oracle for a best-effort RPC validation.  This preserves
                // the previous behaviour and keeps the pipeline running.
                logger.warn(
                  'Payments',
                  'UXF recipient-side finalization failed, falling back to assembled JSON',
                  { tokenId: tokenRoot.tokenId.slice(0, 16), err: finalizeErr },
                );
                tokenData = assembledJson;
                // tokenStatus remains 'confirmed'
              }
            }
            // If stClient/trustBase are absent (e.g., in tests with mocked
            // oracle), fall through with tokenData = assembledJson and
            // tokenStatus = 'confirmed' (pre-existing behaviour).
          }

          // 2. Validate via oracle — skipped for pending instant-mode tokens
          //    (spec §5.3 [E]: unfinalizedCount > 0 → PENDING, isSpent
          //    check deferred until allFinalized).
          if (tokenStatus !== 'pending') {
            const validation = await this.deps!.oracle.validateToken(tokenData);
            // [DIAG-UXF-RECV] oracle validation outcome
            logger.debug('Payments', '[DIAG-UXF-RECV] oracle.validateToken result', {
              tokenId: tokenRoot.tokenId.slice(0, 16),
              valid: validation.valid,
            });
            if (!validation.valid) {
              logger.warn('Payments', 'Received invalid UXF token', {
                tokenId: tokenRoot.tokenId.slice(0, 16),
              });
              return;
            }
          }

          // 3. Parse + build wallet Token — mirrors legacy arm lines ~7751-7768.
          const tokenInfo = await parseTokenInfo(tokenData);
          const sdkDataStr = typeof tokenData === 'string'
            ? tokenData
            : JSON.stringify(tokenData);
          const token: Token = {
            id: tokenInfo.tokenId ?? crypto.randomUUID(),
            coinId: tokenInfo.coinId,
            symbol: tokenInfo.symbol,
            name: tokenInfo.name,
            decimals: tokenInfo.decimals,
            iconUrl: tokenInfo.iconUrl,
            amount: tokenInfo.amount,
            status: tokenStatus,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            sdkData: sdkDataStr,
          };

          // 4. addToken() deduplicates (tombstone check + stateHash check)
          //    and persists via save() — mirrors legacy arm line ~7772.
          const added = await this.addToken(token);
          // [DIAG-UXF-RECV] addToken outcome
          logger.debug('Payments', '[DIAG-UXF-RECV] addToken result', {
            tokenId: tokenRoot.tokenId.slice(0, 16),
            added,
            coinId: token.coinId.slice(0, 16),
            amount: token.amount,
          });
          const senderInfo = await this.resolveSenderInfo(ctx.senderTransportPubkey);

          if (added) {
            // 5. Record history entry — mirrors legacy arm lines ~7776-7787.
            const incomingTokenId = extractTokenIdFromSdkData(token.sdkData);
            await this.addToHistory({
              type: 'RECEIVED',
              amount: token.amount,
              coinId: token.coinId,
              symbol: token.symbol,
              timestamp: Date.now(),
              senderPubkey: ctx.senderTransportPubkey,
              ...senderInfo,
              memo: ctx.payload.memo,
              tokenId: incomingTokenId || token.id,
            });

            // 6. Emit transfer:incoming — mirrors legacy arm lines ~7789-7798.
            const incomingTransfer: IncomingTransfer = {
              id: ctx.bundleCid,
              senderPubkey: ctx.senderTransportPubkey,
              senderNametag: senderInfo.senderNametag,
              tokens: [token],
              memo: ctx.payload.memo,
              receivedAt: Date.now(),
            };
            this.deps!.emitEvent('transfer:incoming', incomingTransfer);
            logger.debug(
              'Payments',
              `UXF token received: ${token.id}, ${token.amount} ${token.symbol}`,
            );
          } else {
            logger.debug(
              'Payments',
              `UXF duplicate token ignored: ${token.id}, ${token.amount} ${token.symbol}`,
            );
          }
        } catch (err) {
          logger.error('Payments', 'Default UXF processToken failed', {
            tokenId: tokenRoot.tokenId.slice(0, 16),
            err,
          });
          // Re-throw so the pool aborts this token only (per-token error
          // isolation is the pool's responsibility per §5.0 W23).
          throw err;
        }
      };

      this.ingestPool = new IngestWorkerPool({
        lru,
        perTokenMutex: mutex,
        processToken,
        emit: (event, payload) => this.deps!.emitEvent(event, payload),
      });
      logger.debug(
        'Payments',
        'Default IngestWorkerPool auto-installed (recipientUxf default-on)',
      );
    }

    // Phase 9.6.D — auto-install the sender-side finalization worker when
    // `senderUxf` is on AND `finalizationWorker` is on AND no consumer has
    // already installed one via `installFinalizationWorkerSender()`.
    //
    // The auto-installed worker uses lightweight in-memory adapters for the
    // pool/manifest/tombstone/queue 4-step write order (no OrbitDB required).
    // These in-memory writes are sufficient to drive the §6.1 cycle to
    // completion and emit `transfer:confirmed`. The full OrbitDB-backed
    // adapters can be injected by the bootstrap layer (Sphere) via
    // `installFinalizationWorkerSender()` when it has the full profile stack.
    //
    // Consumer-installed workers (installFinalizationWorkerSender()) win:
    // the `!this.finalizationWorkerSender` check preserves that contract.
    if (
      this.features.senderUxf &&
      this.features.finalizationWorker &&
      !this.finalizationWorkerSender
    ) {
      const aggregatorClient = this.deps!.oracle.getAggregatorClient?.();
      if (aggregatorClient === null || aggregatorClient === undefined) {
        // Oracle stub does not expose an aggregator client; skip auto-install.
        // Tests with mocked oracles (no getAggregatorClient) take this path.
        logger.debug(
          'Payments',
          'FinalizationWorkerSender auto-install skipped: oracle has no getAggregatorClient()',
        );
      } else {
        const directAddr = this.deps!.identity.directAddress;
        const workerAddressId =
          typeof directAddr === 'string' && directAddr.length > 0
            ? computeAddressId(directAddr)
            : this.deps!.identity.chainPubkey;
        this.finalizationWorkerSender = buildDefaultFinalizationWorkerSender({
          addressId: workerAddressId,
          oracle: this.deps!.oracle,
          senderOutboxMap: this._senderOutboxMap,
          senderRequestContextMap: this._senderRequestContextMap,
          emit: (type, data) => this.deps!.emitEvent(type, data),
        });
        this.finalizationWorkerSender.start();
        logger.debug(
          'Payments',
          'Default FinalizationWorkerSender auto-installed (senderUxf default-on)',
        );
      }
    }
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
      //
      // Address guard: reject data whose `_meta.address` doesn't match the
      // current identity. Accept three representations (one per writer):
      //   - L1 bech32 (legacy file storage writes this)
      //   - chain pubkey (some providers record the pubkey)
      //   - Profile short ID (`DIRECT_{first6}_{last6}` — written by
      //     ProfileTokenStorageProvider, derived via `computeAddressId`)
      //
      // NOTE: This guard is an integrity check (catch misrouted or
      // corrupted data), not a security boundary. A writer with storage
      // access can forge `_meta.address` trivially.
      const currentL1 = this.deps!.identity.l1Address;
      const currentChain = this.deps!.identity.chainPubkey;
      const currentDirect = this.deps!.identity.directAddress;
      const currentProfileShortId = currentDirect ? computeAddressId(currentDirect) : null;

      const providers = this.getTokenStorageProviders();
      for (const [id, provider] of providers) {
        try {
          const result = await provider.load();
          if (result.success && result.data) {
            const loadedMeta = (result.data as TxfStorageDataBase)?._meta;
            if (
              loadedMeta?.address &&
              loadedMeta.address !== currentL1 &&
              loadedMeta.address !== currentChain &&
              loadedMeta.address !== currentProfileShortId
            ) {
              const accepted = [
                currentL1 ? `L1=${currentL1.slice(0, 16)}…` : null,
                currentChain ? `chain=${currentChain.slice(0, 16)}…` : null,
                currentProfileShortId ? `profile=${currentProfileShortId}` : null,
              ].filter(Boolean).join(', ');
              logger.warn(
                'Payments',
                `Load: rejecting data from provider ${id} — address mismatch (got=${loadedMeta.address.slice(0, 24)} accepted=[${accepted}])`,
              );
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

      // Restore pending V5 tokens
      await this.loadPendingV5Tokens();

      // Restore processed split group IDs for dedup across reloads
      await this.loadProcessedSplitGroupIds();
      await this.loadProcessedCombinedTransferIds();

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

    // After loading, try to resolve any unconfirmed tokens and start
    // periodic retries so tokens don't stay stuck as 'submitted'.
    this.resolveUnconfirmed().catch((err) => logger.debug('Payments', 'resolveUnconfirmed failed', err));
    this.scheduleResolveUnconfirmed();
  }

  /**
   * Install the recipient-side ingest worker pool (T.3.E §5.0).
   *
   * Idempotent: a second call replaces the previous pool, destroying it
   * first. The bootstrap layer (Sphere) calls this once after wiring up
   * the disposition engine + writer; subsequent calls are reserved for
   * test harnesses.
   *
   * **No-op when `features.recipientUxf === false`** — the pool sits
   * unused and the legacy `handleIncomingTransfer` path runs for every
   * arrival. Installing a pool is cheap (no workers spin up until
   * `IngestWorkerPool`'s constructor runs); the gate is the flag.
   *
   * @param pool A pre-constructed {@link IngestWorkerPool} OR a
   *             {@link IngestWorkerPoolOptions} object (the module
   *             constructs the pool itself in the latter case).
   */
  installIngestWorkerPool(pool: IngestWorkerPool | IngestWorkerPoolOptions): void {
    if (this.ingestPool) {
      // Fire-and-forget destroy — caller is replacing the pool, so
      // they don't care about prior worker drainage timing.
      void this.ingestPool.destroy().catch(() => undefined);
    }
    this.ingestPool =
      pool instanceof IngestWorkerPool ? pool : new IngestWorkerPool(pool);
  }

  // ===========================================================================
  // T.5.D — Operator escape-hatch (`importInclusionProof` +
  // `revalidateCascadedChildren`). The wiring layer (Sphere bootstrap)
  // installs the importer + runner via the two `install*` methods below;
  // the public API methods then delegate to whichever is installed.
  //
  // Both are NULL until installed — the public methods throw
  // `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED` if invoked before installation,
  // which surfaces a clear error in environments where the legacy code
  // paths run without the UXF-aware infrastructure.
  // ===========================================================================

  /** @internal — set by `installInclusionProofImporter()`. */
  private inclusionProofImporter: InclusionProofImporter | null = null;
  /** @internal — set by `installRevalidateCascadedRunner()`. */
  private revalidateCascadedRunner: RevalidateCascadedRunner | null = null;
  /** @internal — set by `installSendingRecoveryWorker()`. Phase 8 steelman. */
  private sendingRecoveryWorker: SendingRecoveryWorker | null = null;
  /** @internal — auto-installed or set by `installFinalizationWorkerSender()`. Phase 9.6.D. */
  private finalizationWorkerSender: FinalizationWorkerSender | null = null;

  /**
   * In-memory outbox for the sender-side finalization worker.
   * Stores `UxfTransferOutboxEntry` objects by outbox id.
   * The instant-sender writes here at `delivered-instant` stage;
   * the worker reads + updates via the injected `FinalizationOutboxWriter`.
   *
   * @internal
   */
  private readonly _senderOutboxMap: Map<string, UxfTransferOutboxEntry> = new Map();

  /**
   * Per-requestId context map for the sender-side finalization worker resolver.
   * Populated by `dispatchUxfInstantSend`'s `commitSources` callback
   * with `(requestIdHex → RequestContext)`.
   *
   * @internal
   */
  private readonly _senderRequestContextMap: Map<string, RequestContext> = new Map();

  /**
   * Install the operator inclusion-proof importer (T.5.D, §6.3 escape
   * hatch). Idempotent — a second call replaces the previous importer.
   *
   * The Sphere bootstrap layer constructs the importer with the
   * production-wired manifest store, disposition storage, finalization
   * queue scanner, proof verifier, graft callback, override callback,
   * and event emitter. Tests inject a fully-mocked importer.
   */
  installInclusionProofImporter(importer: InclusionProofImporter): void {
    this.inclusionProofImporter = importer;
  }

  /**
   * Install the operator cascade-revalidation runner (T.5.D consumer of
   * T.5.B.5 cascade walker). Idempotent — a second call replaces the
   * previous runner.
   */
  installRevalidateCascadedRunner(runner: RevalidateCascadedRunner): void {
    this.revalidateCascadedRunner = runner;
  }

  /**
   * Phase 8 steelman post-cutover — install the sending-recovery
   * worker. Idempotent: a second call stops the previous worker
   * (await its in-flight scan) and swaps in the new instance. If
   * `features.recoveryWorker` is `true`, the next `initialize()` call
   * starts the new worker; if the module is already initialized, the
   * worker is started immediately.
   *
   * The bootstrap layer (Sphere) constructs the worker with a closure
   * over the production transport + outbox + republish payload
   * builder. Tests inject a fully-mocked worker.
   *
   * **No-op when `features.recoveryWorker === false`** — installing is
   * cheap (no scan loop runs until `start()`); the gate is the flag.
   */
  installSendingRecoveryWorker(worker: SendingRecoveryWorker): void {
    // Stop the previous worker without blocking the install. We
    // intentionally do not await here — callers may be hot-swapping
    // workers under test, and the worker's stop() is documented as
    // "best-effort, never throws". Errors are swallowed.
    if (this.sendingRecoveryWorker !== null) {
      void this.sendingRecoveryWorker.stop().catch(() => undefined);
    }
    this.sendingRecoveryWorker = worker;
    // If the module is already initialized AND the gate is on, start
    // the new worker immediately. Otherwise, the next initialize()
    // call will start it (see initialize() body).
    if (this.deps !== null && this.features.recoveryWorker) {
      worker.start();
    }
  }

  /**
   * Phase 9.6.D — install the sender-side finalization worker.
   *
   * Idempotent: a second call stops the previous worker (fire-and-
   * forget) and swaps in the new instance. If the module is already
   * initialized AND `features.senderUxf` is true, the new worker is
   * started immediately.
   *
   * Consumer-installed workers WIN over the auto-installed default:
   * call this BEFORE `initialize()` to prevent the auto-install, OR
   * call it AFTER `initialize()` to replace the auto-installed instance
   * (the latter triggers an immediate start if the gate is open).
   *
   * The bootstrap layer (Sphere) can inject a fully production-wired
   * worker backed by the OrbitDB pool/manifest/tombstone/queue adapters.
   * Tests inject a fully-mocked worker.
   */
  installFinalizationWorkerSender(worker: FinalizationWorkerSender): void {
    if (this.finalizationWorkerSender !== null) {
      void this.finalizationWorkerSender.stop().catch(() => undefined);
    }
    this.finalizationWorkerSender = worker;
    if (this.deps !== null && this.features.senderUxf) {
      worker.start();
    }
  }

  /**
   * §6.3 stuck-PENDING escape hatch — accept an inclusion proof from
   * outside the normal aggregator path and apply it to local state.
   *
   * The caller MUST set `allowInvalidOverride: true` to flip a token
   * from `_invalid` back to the active pool — silent default would
   * breach the §5.6 monotonicity invariant. The override is sticky
   * across CRDT merges (`overrideApplied: true` survives every future
   * merge) and emits `transfer:override-applied` for the operator
   * console's audit trail.
   *
   * The 10 sub-cases of §6.3 are implemented in
   * `transfer/import-inclusion-proof.ts` (T.5.D).
   *
   * @param addr     Address scope.
   * @param tokenId  Canonical token id.
   * @param proof    Operator-supplied inclusion proof descriptor.
   * @param options  Optional `{ allowInvalidOverride, operatorPubkey,
   *                  currentTime }`.
   *
   * @throws SphereError `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED` if the
   *   importer has not been installed. Callers SHOULD NOT silently
   *   no-op on this — surface it to the operator console.
   */
  async importInclusionProof(
    addr: string,
    tokenId: string,
    proof: ImportableInclusionProof,
    options?: ImportInclusionProofCallOptions,
  ): Promise<ImportProofResult> {
    if (this.inclusionProofImporter === null) {
      throw new SphereError(
        'PaymentsModule.importInclusionProof: inclusion-proof importer not installed. ' +
          'Call installInclusionProofImporter() during bootstrap.',
        'OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED',
      );
    }
    return this.inclusionProofImporter.importInclusionProof(
      addr,
      tokenId,
      proof,
      options,
    );
  }

  /**
   * §6.1.1 operator-explicit cascade reversal — re-validate every
   * cascaded child of `parentTokenId` after the operator has flipped
   * the parent via {@link importInclusionProof}.
   *
   * Transitive: when a child re-validates, the runner recurses into
   * the child's children. Bounded depth (`MAX_CHAIN_DEPTH` = 64) and
   * per-call-stack visited-set defend against corrupted-manifest
   * cycles (W32).
   *
   * The actual cascade walk semantics live in T.5.B.5
   * (`transfer/cascade-walker.ts`); this method delegates to a
   * dedicated runner (`transfer/revalidate-cascaded.ts`) that consumes
   * the cascade walker's manifest-scanner contract.
   *
   * @throws SphereError `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED` if the
   *   runner has not been installed.
   */
  async revalidateCascadedChildren(
    addr: string,
    parentTokenId: string,
  ): Promise<RevalidationResult> {
    if (this.revalidateCascadedRunner === null) {
      throw new SphereError(
        'PaymentsModule.revalidateCascadedChildren: revalidate-cascaded runner not installed. ' +
          'Call installRevalidateCascadedRunner() during bootstrap.',
        'OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED',
      );
    }
    return this.revalidateCascadedRunner.run(addr, parentTokenId);
  }

  /**
   * Install the recipient-side legacy-shape adapter runner (T.7.B).
   *
   * When `features.recipientLegacyAdapter === true` AND a runner is
   * installed, every inbound legacy event is routed through the runner
   * BEFORE the existing legacy storage path runs. The two paths are
   * additive: the runner produces dispositions for the OrbitDB profile
   * (T.3.C); the existing path continues to populate the legacy token
   * storage. Both observe the same event from the same transport
   * subscription.
   *
   * Idempotent: a second call replaces the previous runner.
   *
   * **No-op when `features.recipientLegacyAdapter === false`** — the
   * runner is dormant and the legacy path runs alone.
   */
  installLegacyShapeAdapter(runner: LegacyShapeAdapterRunner): void {
    this.legacyShapeAdapterRunner = runner;
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

    // Stop V5 resolve-unconfirmed retry polling
    this.stopResolveUnconfirmedPolling();

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

    // T.3.E — destroy the ingest worker pool. Fire-and-forget per the
    // module's destroy() contract (synchronous return). Workers drain
    // in the background; queued bundles reject with `MODULE_DESTROYED`.
    if (this.ingestPool) {
      void this.ingestPool.destroy().catch(() => undefined);
      this.ingestPool = null;
    }

    // Phase 8 steelman post-cutover — stop the sending-recovery worker.
    // Fire-and-forget for consistency with the rest of `destroy()`'s
    // synchronous contract; the worker's `stop()` awaits its in-flight
    // scan internally and never throws.
    if (this.sendingRecoveryWorker) {
      void this.sendingRecoveryWorker.stop().catch(() => undefined);
      this.sendingRecoveryWorker = null;
    }

    // Phase 9.6.D — stop the sender-side finalization worker.
    // Fire-and-forget; `stop()` drains in-flight polls and never throws.
    if (this.finalizationWorkerSender) {
      void this.finalizationWorkerSender.stop().catch(() => undefined);
      this.finalizationWorkerSender = null;
    }
    // Clear in-memory outbox and context maps (no persistent side-effects).
    this._senderOutboxMap.clear();
    this._senderRequestContextMap.clear();
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
    originalRequest: TransferRequest,
    internal?: { existingReservationId?: string; existingSplitPlan?: SplitPlan },
  ): Promise<TransferResult> {
    this.ensureInitialized();

    // T.1.B.1 — narrow public TransferMode to InternalTransferMode and reject
    // any future-protocol value (notably `'txf'`) with the typed
    // `UNSUPPORTED_TRANSFER_MODE` error BEFORE we mutate any state. The
    // shim is the SDK's only runtime narrow; routing the legacy TXF arm
    // is owned by T.7.A. New TransferRequest fields (`additionalAssets`,
    // `delivery`, `allowPendingTokens`, `confirmNftPending`,
    // `txfFinalization`) are accepted but UNUSED at this wave — the
    // legacy code path below remains the only routing branch.
    // TODO(T.2.B/T.2.C/T.5.B/T.7.A): consume the new TransferRequest
    // fields once the multi-asset validator and delivery resolver land.
    //
    // T.1.B.2 — call `narrowTransferMode` directly; the per-call-site
    // alias `coercePartialTransferRequestMode` was removed once T.7.C
    // migrated production callers to pass `transferMode` explicitly.
    //
    // T.7.E (default-mode flip) — when `originalRequest.transferMode` is
    // `undefined`, the shim returns `'instant'` per §2.5 ("Default:
    // `transferMode: 'instant'` over UXF"). The string value is the same
    // as the historical default; the SEMANTIC flip is in the dispatcher
    // below: with `features.senderUxf === true` the default routes to
    // `dispatchUxfInstantSend` (UXF instant). Pre-T.7.E the equivalent
    // default was "instant over legacy TXF" (the staged-rollout fall-
    // through that T.8.D removes). Callers who need the legacy single-
    // token TXF wire format MUST pass `transferMode: 'txf'` explicitly
    // (and have `features.senderUxf` ON — see T.7.A's typed reject).
    const internalTransferMode = narrowTransferMode(originalRequest.transferMode);

    // T.8.B — Capability hint surface check (§10.4, W20).
    // BEFORE any dispatcher, consult the resolved peer's capability hints.
    // Mismatches emit `transfer:capability-warning` and proceed unchanged —
    // we DO NOT auto-strip NFT entries, DO NOT downgrade the wire format,
    // and DO NOT block the send. The actual interop guarantee comes from
    // the receiver's T.2.B `UNKNOWN_ASSET_KIND` reject rule. Failure to
    // resolve the peer here is non-fatal (the dispatcher will resolve
    // again and surface its own typed error).
    await this.maybeEmitCapabilityWarning(originalRequest, internalTransferMode).catch((err) => {
      logger.warn('PaymentsModule', 'Capability warning check failed (informational, ignoring):', err);
    });

    // T.2.D.1 — UXF conservative dispatcher (feature-flag-gated).
    // When `features.senderUxf === true` AND the request is conservative-mode,
    // route through the new UXF wire-format orchestrator. Otherwise fall
    // through unchanged. Keep this BEFORE any state mutation so the legacy
    // arm sees identical pre-conditions when the flag is off.
    if (this.features.senderUxf && internalTransferMode === 'conservative') {
      return this.dispatchUxfConservativeSend(originalRequest);
    }
    // T.5.A — UXF instant dispatcher (same feature flag).
    // When `features.senderUxf === true` AND the request is instant-mode,
    // route through the new UXF instant orchestrator. Falls through to
    // the legacy single-token TXF path otherwise.
    //
    // T.7.E — this is the post-flip "default" arm: when the caller omitted
    // `transferMode`, `narrowTransferMode(undefined)` returned `'instant'`,
    // which lands here when `senderUxf` is ON. So `payments.send({
    // recipient, coinId, amount })` with the flag on is now routed
    // through `instant-sender` → emits a UXF bundle (`uxf-cid` wire
    // shape per §3.1). The fall-through to the legacy single-token path
    // when `senderUxf` is OFF is the staged-rollout escape hatch removed
    // by T.8.D.
    if (this.features.senderUxf && internalTransferMode === 'instant') {
      return this.dispatchUxfInstantSend(originalRequest);
    }
    // T.7.A — legacy TXF dispatcher (same feature flag).
    // When `features.senderUxf === true` AND the request explicitly opted
    // into `transferMode: 'txf'` (only reachable via `as TransferMode`
    // cast — the public type still excludes `'txf'`), route through the
    // legacy TXF orchestrator. The orchestrator branches internally on
    // `txfFinalization` (default `'conservative'` per §10.1) to pick the
    // §4.4.1 vs §4.4.2 sequence. The narrowing shim (`narrowTransferMode`)
    // passes `'txf'` through post-T.7.A — the dispatcher is the routing
    // point.
    if (this.features.senderUxf && internalTransferMode === 'txf') {
      const txfFinalization: 'conservative' | 'instant' =
        originalRequest.txfFinalization === 'instant' ? 'instant' : 'conservative';
      return this.dispatchTxfSend(originalRequest, txfFinalization);
    }
    // T.7.A — feature-flag-OFF guard. When the UXF flag is off but the
    // caller passed `transferMode: 'txf'`, the legacy single-token path
    // (which always emits TXF wire shape for both 'instant' and
    // 'conservative' under the V6 / Sphere-TXF detection) is not yet
    // wired to honour the explicit TXF opt-in. Reject with the typed
    // `UNSUPPORTED_TRANSFER_MODE` error so callers know they need to
    // flip `features.senderUxf = true` to use the TXF orchestrator.
    if (!this.features.senderUxf && internalTransferMode === 'txf') {
      throw new SphereError(
        "transferMode: 'txf' requires features.senderUxf = true. " +
          'Either set the flag or omit the field to use the default mode.',
        'UNSUPPORTED_TRANSFER_MODE',
      );
    }
    // T.1.B.1 — `coinId` and `amount` are now optional on the public
    // `TransferRequest`. The legacy single-coin code path below
    // dereferences both fields ubiquitously; until T.2.B lands the §4.1
    // step 1 multi-asset validator that picks the right routing arm,
    // this shim verifies the primary coin slot is present and rebinds
    // `request` to a narrowed `LegacyCoinTransferRequest` (a branded
    // alias with `coinId: string; amount: string;`). NFT-only and
    // multi-asset shapes are accepted by the public type but rejected
    // here — they will become routable once T.2.B lands.
    let request: LegacyCoinTransferRequest = requireLegacyCoinSlot(originalRequest);

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

    // W23-R2 fix: Track tokens committed on-chain so the error handler doesn't
    // restore already-spent tokens (e.g., split source token after on-chain split).
    const committedOnChainTokenIds = new Set<string>();

    try {
      // Resolve recipient
      const peerInfo: PeerInfo | null = await this.deps!.transport.resolve?.(request.recipient) ?? null;
      const recipientPubkey = this.resolveTransportPubkey(request.recipient, peerInfo);
      const recipientAddress = await this.resolveRecipientAddress(request.recipient, request.addressMode, peerInfo);

      // Create signing service
      const signingService = await this.createSigningService();

      // Get state transition client and trust base
      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      if (!stClient) {
        throw new SphereError('State transition client not available. Oracle provider must implement getStateTransitionClient()', 'AGGREGATOR_ERROR');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trustBase = (this.deps!.oracle as any).getTrustBase?.();
      if (!trustBase) {
        throw new SphereError('Trust base not available. Oracle provider must implement getTrustBase()', 'AGGREGATOR_ERROR');
      }

      let splitPlan: SplitPlan;

      if (internal?.existingSplitPlan) {
        // W23 fix: Reuse the reservation + plan from instantSplitSend to avoid
        // the cancel-then-reacquire race window.
        splitPlan = internal.existingSplitPlan;
      } else {
        // ── Coin symbol → coinId resolution ────────────────────────────────────
        // Delegate to the shared helper (see `resolveCoinIdSymbol`).
        request = requireLegacyCoinSlot(this.resolveCoinIdSymbol(request));

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

      // T.1.B.1 — `internalTransferMode` was narrowed at entry (line ~1273)
      // by the per-call-site shim. By the time we reach this branch the
      // value is one of `'instant' | 'conservative'` (the `'txf'` arm
      // throws synchronously in the shim until T.7.A wires it). Keep the
      // local `transferMode` name for minimal diff against the legacy
      // routing logic below.
      const transferMode: 'instant' | 'conservative' = internalTransferMode === 'conservative' ? 'conservative' : 'instant';

      const onChainMessage = parseInvoiceMemoForOnChain(
        request.memo,
        request.invoiceRefundAddress,
        request.invoiceContact,
      );

      if (transferMode === 'conservative') {
        // =================================================================
        // CONSERVATIVE MODE: each token sent individually with full proofs
        // =================================================================

        // Handle split if required
        if (splitPlan.requiresSplit && splitPlan.tokenToSplit) {
          logger.debug('Payments', 'Executing conservative split...');
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
            onChainMessage,
          );

          // Mark split source token as committed on-chain — cannot be restored on error
          committedOnChainTokenIds.add(splitPlan.tokenToSplit!.uiToken.id);

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
          await this.addToken(changeUiToken);
          logger.debug('Payments', `Conservative split: change token saved: ${changeUiToken.id}`);

          // Send fully finalized { sourceToken, transferTx } via Nostr
          await this.deps!.transport.sendTokenTransfer(recipientPubkey, {
            sourceToken: JSON.stringify(splitResult.tokenForRecipient.toJSON()),
            transferTx: JSON.stringify(splitResult.recipientTransferTx.toJSON()),
            memo: request.memo,
          } as unknown as import('../../transport').TokenTransferPayload);

          const splitCommitmentRequestId = splitResult.recipientTransferTx?.data?.requestId
            ?? splitResult.recipientTransferTx?.requestId;
          const splitRequestIdHex = splitCommitmentRequestId instanceof Uint8Array
            ? Array.from(splitCommitmentRequestId).map((b: number) => b.toString(16).padStart(2, '0')).join('')
            : splitCommitmentRequestId ? String(splitCommitmentRequestId) : undefined;

          await this.removeToken(splitPlan.tokenToSplit.uiToken.id, result.id);
          result.tokenTransfers.push({
            sourceTokenId: splitPlan.tokenToSplit.uiToken.id,
            method: 'split',
            requestIdHex: splitRequestIdHex,
          });
          logger.debug('Payments', 'Conservative split transfer completed');
        }

        // Transfer direct tokens
        for (const tokenWithAmount of splitPlan.tokensToTransferDirectly) {
          const token = tokenWithAmount.uiToken;
          const commitment = await this.createSdkCommitment(token, recipientAddress, signingService, onChainMessage);

          logger.debug('Payments', `CONSERVATIVE: Sending direct token ${token.id.slice(0, 8)}... to ${recipientPubkey.slice(0, 8)}...`);

          const submitResponse = await stClient.submitTransferCommitment(commitment);
          if (submitResponse.status !== 'SUCCESS' && submitResponse.status !== 'REQUEST_ID_EXISTS') {
            throw new SphereError(`Transfer commitment failed: ${submitResponse.status}`, 'TRANSFER_FAILED');
          }
          // W23-R3 fix: Mark token as committed on-chain — cannot be restored on error
          committedOnChainTokenIds.add(token.id);

          const inclusionProof = await waitInclusionProof(trustBase, stClient, commitment);
          const transferTx = commitment.toTransaction(inclusionProof);

          await this.deps!.transport.sendTokenTransfer(recipientPubkey, {
            sourceToken: JSON.stringify(tokenWithAmount.sdkToken.toJSON()),
            transferTx: JSON.stringify(transferTx.toJSON()),
            memo: request.memo,
          } as unknown as import('../../transport').TokenTransferPayload);
          logger.debug('Payments', 'CONSERVATIVE: Direct token sent successfully');

          const requestIdBytes = commitment.requestId;
          const requestIdHex = requestIdBytes instanceof Uint8Array
            ? Array.from(requestIdBytes).map(b => b.toString(16).padStart(2, '0')).join('')
            : (typeof (requestIdBytes as { toJSON?: () => string }).toJSON === "function" ? (requestIdBytes as { toJSON: () => string }).toJSON() : String(requestIdBytes));

          result.tokenTransfers.push({
            sourceTokenId: token.id,
            method: 'direct',
            requestIdHex,
          });
          logger.debug('Payments', `Token ${token.id} sent via CONSERVATIVE, requestId: ${requestIdHex}`);
          await this.removeToken(token.id, result.id);
        }
      } else {
        // =================================================================
        // INSTANT MODE: collect all tokens into ONE CombinedTransferBundleV6
        // =================================================================

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const devMode = (this.deps!.oracle as any).isDevMode?.() ?? false;
        const senderPubkey = this.deps!.identity.chainPubkey;

        // Placeholder ID for the change token — set after sending, read by background callback
        let changeTokenPlaceholderId: string | null = null;

        // 1. Build split bundle (if needed) — does NOT send
        let builtSplit: import('../../types/instant-split').BuildSplitBundleResult | null = null;
        if (splitPlan.requiresSplit && splitPlan.tokenToSplit) {
          logger.debug('Payments', 'Building instant split bundle...');
          const executor = new InstantSplitExecutor({
            stateTransitionClient: stClient,
            trustBase,
            signingService,
            devMode,
          });

          builtSplit = await executor.buildSplitBundle(
            splitPlan.tokenToSplit.sdkToken,
            splitPlan.splitAmount!,
            splitPlan.remainderAmount!,
            splitPlan.coinId,
            recipientAddress,
            {
              memo: request.memo,
              message: onChainMessage,
              onChangeTokenCreated: async (changeToken) => {
                const changeTokenData = changeToken.toJSON();
                // Remove placeholder — it was a temporary UI stand-in
                if (changeTokenPlaceholderId && this.tokens.has(changeTokenPlaceholderId)) {
                  this.tokens.delete(changeTokenPlaceholderId);
                }
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
                await this.addToken(uiToken);
                logger.debug('Payments', `Change token saved via background: ${uiToken.id}`);
              },
              onStorageSync: async () => {
                await this.save();
                return true;
              },
            }
          );
          logger.debug('Payments', `Split bundle built: splitGroupId=${builtSplit.splitGroupId}`);
          // W23-R3 fix: Mark split source token as committed on-chain in instant mode too.
          // buildSplitBundle submits the burn commitment; if subsequent steps fail,
          // the catch block must NOT restore this already-spent token.
          committedOnChainTokenIds.add(splitPlan.tokenToSplit!.uiToken.id);
        }

        // 2. Prepare direct token entries in parallel — does NOT send
        const directCommitments = await Promise.all(
          splitPlan.tokensToTransferDirectly.map((tw: TokenWithAmount) =>
            this.createSdkCommitment(tw.uiToken, recipientAddress, signingService, onChainMessage)
          )
        );

        const directTokenEntries: DirectTokenEntry[] = splitPlan.tokensToTransferDirectly.map(
          (tw: TokenWithAmount, i: number) => ({
            sourceToken: JSON.stringify(tw.sdkToken.toJSON()),
            commitmentData: JSON.stringify(directCommitments[i].toJSON()),
            amount: tw.uiToken.amount,
            coinId: tw.uiToken.coinId,
            tokenId: extractTokenIdFromSdkData(tw.uiToken.sdkData) || undefined,
          })
        );

        // 3. Assemble CombinedTransferBundleV6
        const combinedBundle: CombinedTransferBundleV6 = {
          version: '6.0',
          type: 'COMBINED_TRANSFER',
          transferId: result.id,
          splitBundle: builtSplit?.bundle ?? null,
          directTokens: directTokenEntries,
          totalAmount: request.amount.toString(),
          coinId: request.coinId,
          senderPubkey,
          memo: request.memo,
        };

        // 4. Send ONE Nostr message
        logger.debug(
          'Payments',
          `Sending V6 combined bundle: transfer=${result.id.slice(0, 8)}... ` +
          `split=${!!builtSplit} direct=${directTokenEntries.length}`
        );
        await this.deps!.transport.sendTokenTransfer(recipientPubkey, {
          token: JSON.stringify(combinedBundle),
          proof: null,
          memo: request.memo,
          sender: { transportPubkey: senderPubkey },
        });
        logger.debug('Payments', 'V6 combined bundle sent successfully');

        // 5. Start background: split mint proofs + change token creation
        if (builtSplit) {
          const bgPromise = builtSplit.startBackground();
          this.pendingBackgroundTasks.push(bgPromise);
        }

        // 5a. Create placeholder change token so sender sees correct remainder immediately.
        // The real change token replaces this when background mint proof arrives (~2s).
        if (builtSplit && splitPlan.remainderAmount) {
          changeTokenPlaceholderId = crypto.randomUUID();
          const placeholder: Token = {
            id: changeTokenPlaceholderId,
            coinId: request.coinId,
            symbol: this.getCoinSymbol(request.coinId),
            name: this.getCoinName(request.coinId),
            decimals: this.getCoinDecimals(request.coinId),
            iconUrl: this.getCoinIconUrl(request.coinId),
            amount: splitPlan.remainderAmount.toString(),
            status: 'transferring',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            sdkData: JSON.stringify({ _placeholder: true }),
          };
          this.tokens.set(placeholder.id, placeholder);
          logger.debug('Payments', `Placeholder change token created: ${placeholder.id} (${placeholder.amount})`);
        }

        // 6. Submit direct token commitments to aggregator in background
        for (const commitment of directCommitments) {
          stClient.submitTransferCommitment(commitment).catch(err =>
            logger.error('Payments', 'Background commitment submit failed:', err)
          );
        }

        // 7. Track and remove tokens (removeToken archives + tombstones + saves)
        if (splitPlan.requiresSplit && splitPlan.tokenToSplit) {
          await this.removeToken(splitPlan.tokenToSplit.uiToken.id, result.id);
          result.tokenTransfers.push({
            sourceTokenId: splitPlan.tokenToSplit.uiToken.id,
            method: 'split',
            splitGroupId: builtSplit!.splitGroupId,
          });
        }

        for (let i = 0; i < splitPlan.tokensToTransferDirectly.length; i++) {
          const token = splitPlan.tokensToTransferDirectly[i].uiToken;
          const commitment = directCommitments[i];

          const requestIdBytes = commitment.requestId;
          const requestIdHex = requestIdBytes instanceof Uint8Array
            ? Array.from(requestIdBytes).map(b => b.toString(16).padStart(2, '0')).join('')
            : (typeof (requestIdBytes as { toJSON?: () => string }).toJSON === "function" ? (requestIdBytes as { toJSON: () => string }).toJSON() : String(requestIdBytes));

          result.tokenTransfers.push({
            sourceTokenId: token.id,
            method: 'direct',
            requestIdHex,
          });
          await this.removeToken(token.id, result.id);
        }

        logger.debug('Payments', 'V6 combined transfer completed');
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
        recipientAddress: peerInfo?.directAddress || recipientAddress?.toString() || recipientPubkey,
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

      // Restore tokens and re-add to spend queue cache.
      // W23-R2/R3 fix: Skip tokens that were already committed on-chain or removed
      // (tombstoned) during this send. Restoring those would create phantom tokens.
      for (const token of result.tokens) {
        if (committedOnChainTokenIds.has(token.id)) {
          logger.warn('Payments', `Skipping restoration of on-chain-committed token ${token.id}`);
          continue;
        }
        // Skip tokens that were already removeToken()'d (archived + tombstoned)
        // during a partially-successful conservative send loop
        if (!this.tokens.has(token.id)) {
          logger.warn('Payments', `Skipping restoration of already-removed token ${token.id}`);
          continue;
        }
        token.status = 'confirmed';
        this.tokens.set(token.id, token);
        if (token.sdkData) {
          try {
            const parsed = JSON.parse(token.sdkData);
            const sdkToken = await SdkToken.fromJSON(parsed);
            const amount = this.extractCoinAmountForCache(sdkToken, token.coinId);
            if (amount > 0n) {
              this.parsedTokenCache.set(token.id, { token, sdkToken, amount });
            }
          } catch { /* parse failure — skip */ }
        }
      }

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
   * Extract coin amount from SDK token for the parsed token cache.
   * Used by addToken() to populate the cache for synchronous queue re-evaluation.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractCoinAmountForCache(sdkToken: SdkToken<any>, coinIdHex: string): bigint {
    try {
      if (!sdkToken.coins) return 0n;
      const coinId = CoinId.fromJSON(coinIdHex);
      return sdkToken.coins.get(coinId) ?? 0n;
    } catch {
      return 0n;
    }
  }

  /**
   * Rebuild parsedTokenCache from current confirmed tokens.
   * Called after loadFromStorageData() which bypasses addToken().
   */
  private async rebuildParsedTokenCache(): Promise<void> {
    this.parsedTokenCache.clear();
    for (const [, token] of this.tokens) {
      if (token.status !== 'confirmed' || !token.sdkData) continue;
      try {
        const parsed = JSON.parse(token.sdkData);
        const sdkToken = await SdkToken.fromJSON(parsed);
        const amount = this.extractCoinAmountForCache(sdkToken, token.coinId);
        if (amount > 0n) {
          this.parsedTokenCache.set(token.id, { token, sdkToken, amount });
        }
      } catch {
        // Parse failure — skip
      }
    }
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
    originalRequest: TransferRequest,
    options?: InstantSplitOptions
  ): Promise<InstantSplitResult> {
    this.ensureInitialized();

    // T.1.B.1 — narrow the optional-on-public-API `coinId` / `amount` to a
    // required-string `LegacyCoinTransferRequest`. NFT-only and
    // multi-asset shapes are accepted by the public type but not yet
    // routable on this entry point (awaits T.2.B). The narrow runs
    // BEFORE any state mutation. Mode narrowing is skipped here because
    // `sendInstant()` is itself a routing target of `'instant'` mode and
    // the public-mode → internal-mode shim has run upstream.
    let request: LegacyCoinTransferRequest = requireLegacyCoinSlot(originalRequest);

    const startTime = performance.now();

    let reservationId: string | undefined;
    let tokenToSplitRef: Token | undefined;

    try {
      // Resolve recipient
      const peerInfo: PeerInfo | null = await this.deps!.transport.resolve?.(request.recipient) ?? null;
      const recipientPubkey = this.resolveTransportPubkey(request.recipient, peerInfo);
      const recipientAddress = await this.resolveRecipientAddress(request.recipient, request.addressMode, peerInfo);

      // Create signing service
      const signingService = await this.createSigningService();

      // Get state transition client and trust base
      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      if (!stClient) {
        throw new SphereError('State transition client not available', 'AGGREGATOR_ERROR');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trustBase = (this.deps!.oracle as any).getTrustBase?.();
      if (!trustBase) {
        throw new SphereError('Trust base not available', 'AGGREGATOR_ERROR');
      }

      // ── Spend Queue: reserve tokens (same path as send()) ──
      reservationId = crypto.randomUUID();
      // Symbol → coinId resolution — delegate to shared helper.
      request = requireLegacyCoinSlot(this.resolveCoinIdSymbol(request));
      const parsedPool = await this.spendPlanner.buildParsedPool(
        Array.from(this.tokens.values()),
        request.coinId
      );

      let pendingChangeAmount2 = 0n;
      for (const [, t] of this.tokens) {
        if (t.coinId === request.coinId && t.status === 'transferring') {
          pendingChangeAmount2 += BigInt(t.amount || '0');
        }
      }
      const planResult = this.spendPlanner.planSend(
        request, parsedPool, this.reservationLedger, this.spendQueue, reservationId, pendingChangeAmount2
      );

      let splitPlan;
      if (planResult === 'queued') {
        const queueResult = await this.spendQueue.waitForEntry(reservationId);
        splitPlan = queueResult.splitPlan;
      } else {
        splitPlan = planResult.splitPlan;
      }

      if (!splitPlan) {
        throw new SphereError('Insufficient balance', 'SEND_INSUFFICIENT_BALANCE');
      }

      if (!splitPlan.requiresSplit || !splitPlan.tokenToSplit) {
        // W23 fix: For direct transfers without split, fall back to standard send()
        // but pass the existing reservation ID so send() can reuse it instead of
        // creating a new one. This closes the race window where freed tokens could
        // be grabbed by a concurrent queued entry between cancel and re-reserve.
        logger.debug('Payments', 'No split required, falling back to standard send()');
        try {
          const result = await this.send(request, { existingReservationId: reservationId, existingSplitPlan: splitPlan });
          return {
            success: result.status === 'completed',
            criticalPathDurationMs: performance.now() - startTime,
            error: result.error,
          };
        } finally {
          this.spendQueue.notifyChange(request.coinId);
        }
      }

      logger.debug('Payments', `InstantSplit: amount=${splitPlan.splitAmount}, remainder=${splitPlan.remainderAmount}`);

      // Mark token as transferring
      const tokenToSplit = splitPlan.tokenToSplit.uiToken;
      tokenToSplitRef = tokenToSplit;
      tokenToSplit.status = 'transferring';
      this.tokens.set(tokenToSplit.id, tokenToSplit);
      this.parsedTokenCache.delete(tokenToSplit.id);

      // Check if dev mode
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const devMode = options?.devMode ?? (this.deps!.oracle as any).isDevMode?.() ?? false;

      const onChainMessage: Uint8Array | null = null;

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
          memo: request.memo,
          message: onChainMessage,
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
            await this.addToken(uiToken);
            logger.debug('Payments', `Change token saved via background: ${uiToken.id}`);
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

        // Commit reservation AFTER transfer — removing token passes excludeReservationId
        // to prevent cancelForToken() from cancelling our own in-flight reservation.
        this.reservationLedger.commit(reservationId);

        // Remove the original token
        await this.removeToken(tokenToSplit.id, reservationId);

        // Add to transaction history (single entry for the actual sent amount)
        const recipientNametag = peerInfo?.nametag
          || (request.recipient.startsWith('@') ? request.recipient.slice(1) : undefined);
        const splitTokenId = extractTokenIdFromSdkData(tokenToSplit.sdkData);
        await this.addToHistory({
          type: 'SENT',
          amount: request.amount,
          coinId: request.coinId,
          symbol: this.getCoinSymbol(request.coinId),
          timestamp: Date.now(),
          recipientPubkey,
          recipientNametag,
          recipientAddress: peerInfo?.directAddress || recipientAddress?.toString() || recipientPubkey,
          memo: request.memo,
          tokenId: splitTokenId || undefined,
        });

        await this.save();
      } else {
        // Cancel reservation — free reserved amounts for other sends
        this.reservationLedger.cancel(reservationId);
        // Restore token on failure and re-add to cache
        tokenToSplit.status = 'confirmed';
        this.tokens.set(tokenToSplit.id, tokenToSplit);
        if (tokenToSplit.sdkData) {
          try {
            const parsed = JSON.parse(tokenToSplit.sdkData);
            const sdkToken = await SdkToken.fromJSON(parsed);
            const amount = this.extractCoinAmountForCache(sdkToken, tokenToSplit.coinId);
            if (amount > 0n) {
              this.parsedTokenCache.set(tokenToSplit.id, { token: tokenToSplit, sdkToken, amount });
            }
          } catch { /* parse failure — skip */ }
        }
        this.spendQueue.notifyChange(request.coinId);
      }

      return result;
    } catch (error) {
      // Cancel reservation on exception (only if one was created)
      if (reservationId) {
        this.reservationLedger.cancel(reservationId);
      }

      // Restore token from 'transferring' back to 'confirmed' if it was marked
      if (tokenToSplitRef && tokenToSplitRef.status === 'transferring') {
        tokenToSplitRef.status = 'confirmed';
        this.tokens.set(tokenToSplitRef.id, tokenToSplitRef);
        if (tokenToSplitRef.sdkData) {
          try {
            const parsed = JSON.parse(tokenToSplitRef.sdkData);
            const sdkToken = await SdkToken.fromJSON(parsed);
            const amount = this.extractCoinAmountForCache(sdkToken, tokenToSplitRef.coinId);
            if (amount > 0n) {
              this.parsedTokenCache.set(tokenToSplitRef.id, { token: tokenToSplitRef, sdkToken, amount });
            }
          } catch { /* parse failure — skip */ }
        }
      }

      // Notify queue after all restoration is complete
      if (reservationId) {
        this.spendQueue.notifyChange(request.coinId);
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        criticalPathDurationMs: performance.now() - startTime,
        error: errorMessage,
      };
    }
  }

  // ===========================================================================
  // Shared Helpers for V5 and V6 Receiver Processing
  // ===========================================================================

  /**
   * Save a V5 split bundle as an unconfirmed token (shared by V5 standalone and V6 combined).
   * Returns the created UI token, or null if deduped.
   *
   * @param deferPersistence - If true, skip addToken/save calls (caller batches them).
   *   The token is still added to the in-memory map for dedup; caller must call save().
   */
  private async saveUnconfirmedV5Token(
    bundle: InstantSplitBundleV5,
    senderPubkey: string,
    deferPersistence = false,
  ): Promise<Token | null> {
    const deterministicId = `v5split_${bundle.splitGroupId}`;
    if (this.tokens.has(deterministicId) || this.processedSplitGroupIds.has(bundle.splitGroupId)) {
      logger.debug('Payments', `V5 bundle ${bundle.splitGroupId.slice(0, 12)}... already processed, skipping`);
      return null;
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

    // Record splitGroupId for persistent dedup across page reloads
    this.processedSplitGroupIds.add(bundle.splitGroupId);

    if (deferPersistence) {
      // Only update in-memory map — caller will save() + saveProcessedSplitGroupIds()
      this.tokens.set(uiToken.id, uiToken);
    } else {
      await this.addToken(uiToken);
      await this.saveProcessedSplitGroupIds();
    }

    return uiToken;
  }

  /**
   * Save a commitment-only (NOSTR-FIRST) token and start proof polling.
   * Shared by standalone NOSTR-FIRST handler and V6 combined handler.
   * Returns the created UI token, or null if deduped/tombstoned.
   *
   * @param deferPersistence - If true, skip save() and commitment submission
   *   (caller batches them). Token is added to in-memory map + proof polling is queued.
   * @param skipGenesisDedup - If true, skip genesis-ID-only dedup. V6 handler sets this
   *   because bundle-level dedup protects against replays, and split children share genesis IDs.
   */
  private async saveCommitmentOnlyToken(
    sourceTokenInput: unknown,
    commitmentInput: unknown,
    senderPubkey: string,
    deferPersistence = false,
    skipGenesisDedup = false,
  ): Promise<Token | null> {
    const tokenInfo = await parseTokenInfo(sourceTokenInput);

    const sdkData = typeof sourceTokenInput === 'string'
      ? sourceTokenInput
      : JSON.stringify(sourceTokenInput);

    // Check tombstones BEFORE creating the token
    const nostrTokenId = extractTokenIdFromSdkData(sdkData);
    const nostrStateHash = extractStateHashFromSdkData(sdkData);
    if (nostrTokenId && nostrStateHash && this.isStateTombstoned(nostrTokenId, nostrStateHash)) {
      logger.debug('Payments', `NOSTR-FIRST: Rejecting tombstoned token ${nostrTokenId.slice(0, 8)}..._${nostrStateHash.slice(0, 8)}...`);
      return null;
    }

    // Dedup: check existing tokens
    if (nostrTokenId) {
      for (const existing of this.tokens.values()) {
        const existingTokenId = extractTokenIdFromSdkData(existing.sdkData);
        if (existingTokenId !== nostrTokenId) continue;

        // Exact state match — always reject (duplicate delivery)
        const existingStateHash = extractStateHashFromSdkData(existing.sdkData);
        if (nostrStateHash && existingStateHash === nostrStateHash) {
          logger.debug(
            'Payments',
            `NOSTR-FIRST: Skipping duplicate token state ${nostrTokenId.slice(0, 8)}..._${nostrStateHash.slice(0, 8)}...`
          );
          return null;
        }

        // Same genesis, different state — reject for standalone NOSTR-FIRST (replay after
        // finalization changes stateHash), allow for V6 batches (split children share genesis)
        if (!skipGenesisDedup) {
          logger.debug(
            'Payments',
            `NOSTR-FIRST: Skipping replay of finalized token ${nostrTokenId.slice(0, 8)}...`
          );
          return null;
        }
      }
    }

    const token: Token = {
      id: crypto.randomUUID(),
      coinId: tokenInfo.coinId,
      symbol: tokenInfo.symbol,
      name: tokenInfo.name,
      decimals: tokenInfo.decimals,
      iconUrl: tokenInfo.iconUrl,
      amount: tokenInfo.amount,
      status: 'submitted',  // NOSTR-FIRST: unconfirmed until proof
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };

    // Add token to in-memory map
    this.tokens.set(token.id, token);

    if (!deferPersistence) {
      await this.save();
    }

    // Start proof polling (commitment submission deferred when batching)
    try {
      const commitment = await TransferCommitment.fromJSON(commitmentInput);
      const requestIdBytes = commitment.requestId;
      const requestIdHex = requestIdBytes instanceof Uint8Array
        ? Array.from(requestIdBytes).map(b => b.toString(16).padStart(2, '0')).join('')
        : (typeof (requestIdBytes as { toJSON?: () => string }).toJSON === "function" ? (requestIdBytes as { toJSON: () => string }).toJSON() : String(requestIdBytes));

      if (!deferPersistence) {
        // Submit commitment to aggregator immediately (standalone path)
        const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
        if (stClient) {
          const response = await stClient.submitTransferCommitment(commitment);
          logger.debug('Payments', `NOSTR-FIRST recipient commitment submit: ${response.status}`);
        }
      }

      this.addProofPollingJob({
        tokenId: token.id,
        requestIdHex,
        commitmentJson: JSON.stringify(commitmentInput),
        startedAt: Date.now(),
        attemptCount: 0,
        lastAttemptAt: 0,
        onProofReceived: async (tokenId) => {
          await this.finalizeReceivedToken(tokenId, sourceTokenInput, commitmentInput);
        },
      });
    } catch (err) {
      logger.error('Payments', 'Failed to parse commitment for proof polling:', err);
    }

    return token;
  }

  // ===========================================================================
  // Combined Transfer V6 — Receiver
  // ===========================================================================

  /**
   * Process a received COMBINED_TRANSFER V6 bundle.
   *
   * Unpacks a single Nostr message into its component tokens:
   * - Optional V5 split bundle (saved as unconfirmed, resolved lazily)
   * - Zero or more direct tokens (saved as unconfirmed, proof-polled)
   *
   * Emits ONE transfer:incoming event and records ONE history entry.
   */
  private async processCombinedTransferBundle(
    bundle: CombinedTransferBundleV6,
    senderPubkey: string,
  ): Promise<void> {
    this.ensureInitialized();

    // Ensure load() has completed so dedup checks see all persisted tokens
    if (!this.loaded && this.loadedPromise) {
      await this.loadedPromise;
    }

    // Dedup by transferId
    if (this.processedCombinedTransferIds.has(bundle.transferId)) {
      logger.debug('Payments', `V6 combined transfer ${bundle.transferId.slice(0, 12)}... already processed, skipping`);
      return;
    }

    logger.debug(
      'Payments',
      `Processing V6 combined transfer ${bundle.transferId.slice(0, 12)}... ` +
      `(split=${!!bundle.splitBundle}, direct=${bundle.directTokens.length})`
    );

    const allTokens: Token[] = [];
    const tokenBreakdown: Array<{ id: string; amount: string; source: 'split' | 'direct' }> = [];

    // Pre-parse direct token commitment data once (reused for saving + aggregator submit)
    const parsedDirectEntries = bundle.directTokens.map(entry => ({
      sourceToken: typeof entry.sourceToken === 'string' ? JSON.parse(entry.sourceToken) : entry.sourceToken,
      commitment: typeof entry.commitmentData === 'string' ? JSON.parse(entry.commitmentData) : entry.commitmentData,
    }));

    // 1. Process split bundle (if present) — deferred persistence
    if (bundle.splitBundle) {
      const splitToken = await this.saveUnconfirmedV5Token(bundle.splitBundle, senderPubkey, true);
      if (splitToken) {
        allTokens.push(splitToken);
        tokenBreakdown.push({ id: splitToken.id, amount: splitToken.amount, source: 'split' });
      } else {
        logger.warn('Payments', `V6: split token was deduped/failed — amount=${bundle.splitBundle.amount}`);
      }
    }

    // 2. Process direct tokens in parallel — deferred persistence
    const directResults = await Promise.all(
      parsedDirectEntries.map(({ sourceToken, commitment }) =>
        this.saveCommitmentOnlyToken(sourceToken, commitment, senderPubkey, true, true)
      )
    );
    for (let i = 0; i < directResults.length; i++) {
      const token = directResults[i];
      if (token) {
        allTokens.push(token);
        tokenBreakdown.push({ id: token.id, amount: token.amount, source: 'direct' });
      } else {
        const entry = bundle.directTokens[i];
        logger.warn(
          'Payments',
          `V6: direct token #${i} dropped (amount=${entry.amount}, ` +
          `tokenId=${entry.tokenId?.slice(0, 12) ?? 'N/A'})`
        );
      }
    }

    if (allTokens.length === 0) {
      logger.debug('Payments', 'V6 combined transfer: all tokens deduped, nothing to save');
      return;
    }

    // 3. Batched persistence + sender info resolution in parallel
    this.processedCombinedTransferIds.add(bundle.transferId);
    const [senderInfo] = await Promise.all([
      this.resolveSenderInfo(senderPubkey),
      this.save(),
      this.saveProcessedCombinedTransferIds(),
      ...(bundle.splitBundle ? [this.saveProcessedSplitGroupIds()] : []),
    ]);

    // 4. Submit direct token commitments to aggregator (fire-and-forget, reuse parsed data)
    const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
    if (stClient) {
      for (const { commitment } of parsedDirectEntries) {
        TransferCommitment.fromJSON(commitment).then(c =>
          stClient.submitTransferCommitment(c)
        ).catch(err =>
          logger.error('Payments', 'V6 background commitment submit failed:', err)
        );
      }
    }

    // 5. Emit event + history

    this.deps!.emitEvent('transfer:incoming', {
      id: bundle.transferId,
      senderPubkey,
      senderNametag: senderInfo.senderNametag,
      tokens: allTokens,
      memo: bundle.memo,
      receivedAt: Date.now(),
    });

    // Compute actual received amount from saved tokens (not bundle.totalAmount which is sender's request)
    const actualAmount = allTokens.reduce((sum, t) => sum + BigInt(t.amount || '0'), 0n).toString();

    await this.addToHistory({
      type: 'RECEIVED',
      amount: actualAmount,
      coinId: bundle.coinId,
      symbol: allTokens[0]?.symbol || bundle.coinId,
      timestamp: Date.now(),
      senderPubkey,
      ...senderInfo,
      memo: bundle.memo,
      transferId: bundle.transferId,
      tokenId: allTokens[0]?.id,
      tokenIds: tokenBreakdown,
    });

    // 6. Fire-and-forget: try to resolve V5 tokens immediately
    if (bundle.splitBundle) {
      this.resolveUnconfirmed().catch((err) => logger.debug('Payments', 'resolveUnconfirmed failed', err));
      this.scheduleResolveUnconfirmed();
    }
  }

  /**
   * Persist processed combined transfer IDs to KV storage.
   */
  private async saveProcessedCombinedTransferIds(): Promise<void> {
    const ids = Array.from(this.processedCombinedTransferIds);
    if (ids.length > 0) {
      // Dedup ledger — pure operational state, not a user action.
      await this.setStorageEntry(
        STORAGE_KEYS_ADDRESS.PROCESSED_COMBINED_TRANSFER_IDS,
        JSON.stringify(ids),
        'cache_index',
      );
    }
  }

  /**
   * Load processed combined transfer IDs from KV storage.
   */
  private async loadProcessedCombinedTransferIds(): Promise<void> {
    const data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.PROCESSED_COMBINED_TRANSFER_IDS);
    if (!data) return;
    try {
      const ids = JSON.parse(data) as string[];
      for (const id of ids) {
        this.processedCombinedTransferIds.add(id);
      }
    } catch {
      // Ignore corrupt data
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
    senderPubkey: string,
    memo?: string,
  ): Promise<InstantSplitProcessResult> {
    this.ensureInitialized();

    // Ensure load() has completed so the dedup check below sees all
    // persisted tokens.  Transport may deliver events before load finishes.
    if (!this.loaded && this.loadedPromise) {
      await this.loadedPromise;
    }

    if (!isInstantSplitBundleV5(bundle)) {
      // V4 (dev mode) still processes synchronously
      return this.processInstantSplitBundleSync(bundle, senderPubkey, memo);
    }

    // V5: save immediately as unconfirmed, resolve proofs lazily
    try {
      const uiToken = await this.saveUnconfirmedV5Token(bundle, senderPubkey);
      if (!uiToken) {
        return { success: true, durationMs: 0 };
      }

      // Record in history (once per token — resolveV5Token will NOT add another)
      const senderInfo = await this.resolveSenderInfo(senderPubkey);
      await this.addToHistory({
        type: 'RECEIVED',
        amount: bundle.amount,
        coinId: bundle.coinId,
        symbol: uiToken.symbol,
        timestamp: Date.now(),
        senderPubkey,
        ...senderInfo,
        memo,
        tokenId: uiToken.id,
      });

      // Emit incoming transfer event
      this.deps!.emitEvent('transfer:incoming', {
        id: bundle.splitGroupId,
        senderPubkey,
        senderNametag: senderInfo.senderNametag,
        tokens: [uiToken],
        memo,
        receivedAt: Date.now(),
      });

      await this.save();

      // Fire-and-forget: try to resolve immediately, then start periodic retry
      this.resolveUnconfirmed().catch((err) => logger.debug('Payments', 'resolveUnconfirmed failed', err));
      this.scheduleResolveUnconfirmed();

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
    senderPubkey: string,
    memo?: string,
  ): Promise<InstantSplitProcessResult> {
    try {
      const signingService = await this.createSigningService();

      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      if (!stClient) {
        throw new SphereError('State transition client not available', 'AGGREGATOR_ERROR');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trustBase = (this.deps!.oracle as any).getTrustBase?.();
      if (!trustBase) {
        throw new SphereError('Trust base not available', 'AGGREGATOR_ERROR');
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
            const currentNametag = this.getNametag();
            if (currentNametag?.token) {
              try {
                const nametagToken = await SdkToken.fromJSON(currentNametag.token);
                const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
                const proxy = await ProxyAddress.fromTokenId(nametagToken.id);
                if (proxy.address === proxyAddress) {
                  return nametagToken;
                }
                logger.debug('Payments', `Unicity ID PROXY address mismatch: ${proxy.address} !== ${proxyAddress}`);
                return null;
              } catch (err) {
                logger.debug('Payments', 'Failed to parse nametag token:', err);
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

        const receivedTokenId = extractTokenIdFromSdkData(uiToken.sdkData);
        const senderInfo = await this.resolveSenderInfo(senderPubkey);
        await this.addToHistory({
          type: 'RECEIVED',
          amount: bundle.amount,
          coinId: info.coinId,
          symbol: info.symbol,
          timestamp: Date.now(),
          senderPubkey,
          ...senderInfo,
          memo,
          tokenId: receivedTokenId || uiToken.id,
        });

        await this.save();

        this.deps!.emitEvent('transfer:incoming', {
          id: bundle.splitGroupId,
          senderPubkey,
          senderNametag: senderInfo.senderNametag,
          tokens: [uiToken],
          memo,
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
      // T.7.C — explicit `transferMode: 'instant'` per §10.1 (production call-site
      // migration). This recursive call into `this.send()` is the
      // PaymentsModule-internal recursion site listed in the T.7.C task spec
      // (along with the AccountingModule + CLI sites). The outer
      // `payPaymentRequest()` API does not currently expose a transferMode knob
      // to callers, so the wire shape is fixed at `'instant'` (the default for
      // unflagged production today). If `payPaymentRequest()` ever gains a
      // mode parameter, plumb it through here.
      const result = await this.send({
        coinId: request.coinId,
        amount: request.amount,
        recipient: request.senderPubkey,
        memo: memo || request.message,
        transferMode: 'instant',
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
      throw new SphereError('Transport provider does not support fetchPendingEvents', 'TRANSPORT_ERROR');
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
  // Public API - Token Import / Export
  // ===========================================================================

  /**
   * Export owned tokens as TXF wire-format objects.
   *
   * The returned TxfToken array is the canonical inter-wallet wire
   * format used by {@link send} / {@link receive} and by the legacy
   * TXF serializer. Callers may write it to a file (as JSON) or wrap
   * it into a UXF CAR (via `UxfPackage.ingestAll` + `toCar`) for
   * content-addressable distribution.
   *
   * @param options.ids - Export only these local token IDs.
   * @param options.coinId - Export only tokens of this coin.
   * @param options.includeUnconfirmed - Include tokens whose status is
   *   not 'confirmed'. Default false. Unconfirmed tokens still carry
   *   valid TxfToken structure but the receiving wallet may reject
   *   them during finalization.
   * @returns Array of `{ localId, genesisTokenId, txf }` triples. A
   *   token is skipped if its `sdkData` does not parse to a valid TXF
   *   shape (should not happen for healthy tokens).
   */
  exportTokens(options?: {
    ids?: readonly string[];
    coinId?: string;
    includeUnconfirmed?: boolean;
  }): Array<{ localId: string; genesisTokenId: string; txf: TxfToken }> {
    this.ensureInitialized();

    let candidates = Array.from(this.tokens.values());
    if (options?.ids) {
      const idSet = new Set(options.ids);
      candidates = candidates.filter((t) => idSet.has(t.id));
    }
    if (options?.coinId) {
      candidates = candidates.filter((t) => t.coinId === options.coinId);
    }
    if (!options?.includeUnconfirmed) {
      candidates = candidates.filter((t) => t.status === 'confirmed');
    }

    const out: Array<{ localId: string; genesisTokenId: string; txf: TxfToken }> = [];
    for (const token of candidates) {
      const txf = tokenToTxf(token);
      if (!txf) continue;
      const genesisTokenId = txf.genesis?.data?.tokenId;
      if (!genesisTokenId) continue;
      out.push({ localId: token.id, genesisTokenId, txf });
    }
    return out;
  }

  // (See ImportTokensResult and friends defined at module scope.)
  /**
   * Import tokens from TXF wire-format objects.
   *
   * Each token receives a fresh local UUID. Dedup is performed in-line
   * (not just via addToken) so that the per-token outcome includes a
   * specific reason code instead of an opaque "skipped" flag:
   *
   *   - **'duplicate'**       — exact (tokenId, stateHash) match already owned.
   *   - **'tombstoned'**      — (tokenId, stateHash) was previously spent
   *                            from this wallet; refusing avoids re-accepting
   *                            a state we have already transitioned past.
   *   - **'genesis-exists'**  — strict-mode only: tokenId is owned in a
   *                            DIFFERENT state. Importing would otherwise
   *                            regress the wallet via {@link addToken}'s
   *                            CASE 2 state-update path.
   *   - **'state-replaced'**  — lenient-mode only: the imported token's
   *                            state is taken as authoritative; the
   *                            previously held state of the same tokenId
   *                            is archived. Reported in `added` (with a
   *                            note) rather than `skipped`, because the
   *                            wallet now owns the new state.
   *
   * **Strict mode (`skipExistingGenesis: true`)** disables the
   * state-update behaviour of {@link addToken}: any imported token
   * whose genesis tokenId already exists in the wallet is skipped
   * outright, regardless of stateHash. Use this when the import is
   * intended as an additive UNION (legacy migration, multi-source
   * file import) — without it, an imported older state would archive
   * the wallet's current state, regressing the wallet's view of that
   * token. Forked / reissued token entries (`_forked_*`) are never
   * promoted to active under strict mode for the same reason.
   *
   * @param txfTokens - Array of TxfToken objects (as produced by
   *   {@link exportTokens}, a legacy TXF file, or a UXF CAR that has
   *   been reassembled).
   * @param options.skipExistingGenesis - Default false (lenient).
   * @returns Counts and identifiers for each outcome category.
   */
  async importTokens(
    txfTokens: readonly TxfToken[],
    options?: { skipExistingGenesis?: boolean },
  ): Promise<ImportTokensResult> {
    this.ensureInitialized();

    const added: ImportAdded[] = [];
    const skipped: ImportSkipped[] = [];
    const rejected: ImportRejected[] = [];

    for (const txf of txfTokens) {
      const genesisTokenId = txf?.genesis?.data?.tokenId ?? null;
      if (!genesisTokenId) {
        rejected.push({
          genesisTokenId: null,
          code: 'malformed',
          reason: 'Missing genesis.data.tokenId',
        });
        continue;
      }
      if (!txf.state || !txf.genesis) {
        rejected.push({
          genesisTokenId,
          code: 'malformed',
          reason: 'Missing state or genesis section',
        });
        continue;
      }

      // Effective dedup key combines current-state hash (for
      // finalized tokens) and a genesis-content hash (for pending-
      // mint tokens). See `effectiveDedupKey`.
      const incomingDedupKey = effectiveDedupKey(txf);

      // Real stateHash for the tombstone check — via the canonical
      // `parseSdkDataCached` path. Tombstones are only keyed on
      // concrete post-spend hashes, so pending tokens can never
      // match one (by definition their first state transition
      // hasn't happened yet).
      const incomingStateHash = extractStateHashFromSdkData(
        JSON.stringify(txf),
      );

      // -- Pre-check 1: tombstoned (previously spent).
      if (incomingStateHash && this.isStateTombstoned(genesisTokenId, incomingStateHash)) {
        skipped.push({
          genesisTokenId,
          code: 'tombstoned',
          reason: `(tokenId, stateHash) previously spent from this wallet`,
        });
        continue;
      }

      // Scan in-memory wallet for matching genesis / state. Track
      // the matched token's status so we can distinguish a true
      // "state replaced a live state" from "stale bookkeeping record
      // (spent/invalid) was overwritten" downstream.
      //
      // For the dedup-key comparison we reuse `parseSdkDataCached`
      // via extractStateHashFromSdkData rather than re-parsing each
      // existing token's sdkData in the loop (was O(N×M) JSON.parse
      // on large wallets). For pending existing tokens with empty
      // stateHash, we fall through to the one-off JSON.parse — rare
      // path.
      let exactDuplicateLocalId: string | null = null;
      let genesisMatchLocalId: string | null = null;
      let genesisMatchStatus: TokenStatus | null = null;
      let genesisMatchIsPending = false;
      for (const [existingId, existing] of this.tokens) {
        const existingTokenId = extractTokenIdFromSdkData(existing.sdkData);
        if (existingTokenId !== genesisTokenId) continue;

        const existingStateHash = extractStateHashFromSdkData(existing.sdkData);
        let existingDedupKey: string;
        let existingIsPending = false;
        if (existingStateHash) {
          // Fast path: both via the cached parser — no re-parse.
          existingDedupKey = existingStateHash;
        } else if (existing.sdkData) {
          // Pending existing (empty stateHash). Compute the fallback
          // the same way we did for the incoming token.
          try {
            const existingTxf = JSON.parse(existing.sdkData) as Parameters<typeof effectiveDedupKey>[0];
            existingDedupKey = effectiveDedupKey(existingTxf);
            existingIsPending = true;
          } catch {
            // Malformed sdkData — treat as genesis-only match with
            // no identifiable current state.
            genesisMatchLocalId = existingId;
            genesisMatchStatus = existing.status;
            continue;
          }
        } else {
          genesisMatchLocalId = existingId;
          genesisMatchStatus = existing.status;
          continue;
        }

        if (existingDedupKey === incomingDedupKey) {
          exactDuplicateLocalId = existingId;
          break;
        }
        genesisMatchLocalId = existingId;
        genesisMatchStatus = existing.status;
        genesisMatchIsPending = existingIsPending;
      }

      // -- Pre-check 2: exact duplicate.
      if (exactDuplicateLocalId) {
        skipped.push({
          genesisTokenId,
          code: 'duplicate',
          reason: 'Exact (tokenId, stateHash) already owned',
        });
        continue;
      }

      // -- Pre-check 3: strict-mode genesis collision.
      // Exception: if the wallet's existing copy is a pending-mint
      // (empty current stateHash) and the incoming is finalized
      // (has a real stateHash), allow the upgrade — the incoming
      // carries strictly more information than what we already have,
      // and refusing would leave the wallet stuck on the pending
      // record. This is the common "migrated legacy while mint was
      // in flight, now rerun after finalization" pattern.
      if (options?.skipExistingGenesis && genesisMatchLocalId) {
        const incomingIsPending = incomingDedupKey.startsWith('pending-');
        const upgradingPendingToFinalized = genesisMatchIsPending && !incomingIsPending;
        if (!upgradingPendingToFinalized) {
          skipped.push({
            genesisTokenId,
            code: 'genesis-exists',
            reason: 'Genesis tokenId owned at a different state; strict mode preserves current state',
          });
          continue;
        }
        // Fall through — the incoming finalized state will replace
        // the prior pending record via addToken's state-update path.
      }

      // Build the UI token. Failures here are malformed-input
      // rejections, not skips.
      const localId = crypto.randomUUID();
      let uiToken: Token;
      try {
        uiToken = txfToToken(localId, txf);
      } catch (err) {
        rejected.push({
          genesisTokenId,
          code: 'malformed',
          reason: `txfToToken failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }

      // Hand off to addToken. Pre-checks above mean addToken should
      // not return false here — but defend against it just in case.
      try {
        const addedOk = await this.addToken(uiToken);
        if (addedOk) {
          if (genesisMatchLocalId) {
            // Differentiate:
            //   - Replacing a LIVE state (confirmed/submitted/...):
            //     the user previously held this state of the token;
            //     UI should highlight the overwrite.
            //   - Replacing a DEAD record (spent/invalid): the prior
            //     entry was bookkeeping for a token we no longer
            //     controlled; no user-visible state was lost.
            const isStaleRecord =
              genesisMatchStatus === 'spent' || genesisMatchStatus === 'invalid';
            added.push({
              localId,
              genesisTokenId,
              code: isStaleRecord ? 'stale-record-replaced' : 'state-replaced',
              note: isStaleRecord
                ? 'Overwrote a stale spent/invalid record of the same tokenId'
                : 'Replaced an existing state of the same tokenId (lenient mode)',
            });
          } else {
            added.push({ localId, genesisTokenId, code: 'added' });
          }
        } else {
          // Defensive — addToken returned false despite our pre-checks.
          // This indicates a race (the wallet mutated between our
          // pre-check scan and addToken's own guard) or a guard
          // pattern we didn't enumerate. Log at warn level so field
          // operators can correlate it with transport activity.
          logger.warn(
            'Payments',
            `importTokens: addToken unexpectedly refused token ${genesisTokenId.slice(0, 16)}... ` +
              `after pre-checks (possible race with incoming transfer). Marking as skipped/unknown.`,
          );
          skipped.push({
            genesisTokenId,
            code: 'unknown',
            reason: 'addToken returned false after pre-checks (race or unrecognised guard)',
          });
        }
      } catch (err) {
        rejected.push({
          genesisTokenId,
          code: 'add-failed',
          reason: `addToken failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    return { added, skipped, rejected };
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
    if (!stClient || !trustBase) {
      logger.debug('Payments', `[V5-RESOLVE] resolveUnconfirmed: EARLY EXIT — stClient=${!!stClient} trustBase=${!!trustBase}`);
      return result;
    }

    const signingService = await this.createSigningService();

    const submittedCount = Array.from(this.tokens.values()).filter(t => t.status === 'submitted').length;
    logger.debug('Payments', `[V5-RESOLVE] resolveUnconfirmed: ${submittedCount} submitted token(s) to process`);

    for (const [tokenId, token] of this.tokens) {
      if (token.status !== 'submitted') continue;

      // Check for pending finalization metadata
      const pending = this.parsePendingFinalization(token.sdkData);
      if (!pending) {
        // Legacy commitment-only token (existing proof polling handles these)
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 16)}: no pending finalization metadata, skipping`);
        result.stillPending++;
        continue;
      }

      if (pending.type === 'v5_bundle') {
        logger.debug('Payments', `[V5-RESOLVE] Processing ${tokenId.slice(0, 16)}... stage=${pending.stage} attempt=${pending.attemptCount}`);
        const progress = await this.resolveV5Token(tokenId, token, pending, stClient, trustBase, signingService);
        logger.debug('Payments', `[V5-RESOLVE] Result for ${tokenId.slice(0, 16)}...: ${progress} (stage now: ${pending.stage})`);
        result.details.push({ tokenId, stage: pending.stage, status: progress });
        if (progress === 'resolved') result.resolved++;
        else if (progress === 'failed') result.failed++;
        else result.stillPending++;
      }
    }

    // Always save when any token was processed — this persists intermediate
    // stage progress (e.g. RECEIVED → MINT_SUBMITTED) and attemptCount so
    // that reloads don't restart finalization from scratch.
    if (result.resolved > 0 || result.failed > 0 || result.stillPending > 0) {
      logger.debug('Payments', `[V5-RESOLVE] Saving: resolved=${result.resolved} failed=${result.failed} stillPending=${result.stillPending}`);
      await this.save();
    }
    return result;
  }

  /**
   * Start a periodic interval that retries resolveUnconfirmed() until all
   * tokens are confirmed or failed.  Stops automatically when nothing is
   * pending and is cleaned up by destroy().
   */
  private scheduleResolveUnconfirmed(): void {
    // Don't stack intervals
    if (this.resolveUnconfirmedTimer) return;

    // Only start if there are actually submitted tokens to resolve
    const hasUnconfirmed = Array.from(this.tokens.values()).some(
      (t) => t.status === 'submitted',
    );
    if (!hasUnconfirmed) {
      logger.debug('Payments', '[V5-RESOLVE] scheduleResolveUnconfirmed: no submitted tokens, not starting timer');
      return;
    }

    logger.debug('Payments', `[V5-RESOLVE] scheduleResolveUnconfirmed: starting periodic retry (every ${PaymentsModule.RESOLVE_UNCONFIRMED_INTERVAL_MS}ms)`);
    this.resolveUnconfirmedTimer = setInterval(async () => {
      try {
        const result = await this.resolveUnconfirmed();
        if (result.stillPending === 0) {
          logger.debug('Payments', '[V5-RESOLVE] All tokens resolved, stopping periodic retry');
          this.stopResolveUnconfirmedPolling();
        }
      } catch (err) {
        logger.debug('Payments', '[V5-RESOLVE] Periodic retry error:', err);
      }
    }, PaymentsModule.RESOLVE_UNCONFIRMED_INTERVAL_MS);
  }

  private stopResolveUnconfirmedPolling(): void {
    if (this.resolveUnconfirmedTimer) {
      clearInterval(this.resolveUnconfirmedTimer);
      this.resolveUnconfirmedTimer = null;
    }
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
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: RECEIVED → submitting mint commitment...`);
        const mintDataJson = JSON.parse(bundle.recipientMintData);
        const mintData = await MintTransactionData.fromJSON(mintDataJson);
        const mintCommitment = await MintCommitment.create(mintData);
        const mintResponse = await stClient.submitMintCommitment(mintCommitment);
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: mint response status=${mintResponse.status}`);
        if (mintResponse.status !== 'SUCCESS' && mintResponse.status !== 'REQUEST_ID_EXISTS') {
          throw new SphereError(`Mint submission failed: ${mintResponse.status}`, 'TRANSFER_FAILED');
        }
        pending.stage = 'MINT_SUBMITTED';
        this.updatePendingFinalization(token, pending);
      }

      // Stage: MINT_SUBMITTED → MINT_PROVEN
      if (pending.stage === 'MINT_SUBMITTED') {
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: MINT_SUBMITTED → checking mint proof...`);
        const mintDataJson = JSON.parse(bundle.recipientMintData);
        const mintData = await MintTransactionData.fromJSON(mintDataJson);
        const mintCommitment = await MintCommitment.create(mintData);
        const proof = await this.quickProofCheck(stClient, trustBase, mintCommitment);
        if (!proof) {
          logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: mint proof not yet available, staying MINT_SUBMITTED`);
          this.updatePendingFinalization(token, pending);
          return 'pending';
        }
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: mint proof obtained!`);
        pending.mintProofJson = JSON.stringify(proof);
        pending.stage = 'MINT_PROVEN';
        this.updatePendingFinalization(token, pending);
      }

      // Stage: MINT_PROVEN → TRANSFER_SUBMITTED
      if (pending.stage === 'MINT_PROVEN') {
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: MINT_PROVEN → submitting transfer commitment...`);
        const transferCommitmentJson = JSON.parse(bundle.transferCommitment);
        const transferCommitment = await TransferCommitment.fromJSON(transferCommitmentJson);
        const transferResponse = await stClient.submitTransferCommitment(transferCommitment);
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: transfer response status=${transferResponse.status}`);
        if (transferResponse.status !== 'SUCCESS' && transferResponse.status !== 'REQUEST_ID_EXISTS') {
          throw new SphereError(`Transfer submission failed: ${transferResponse.status}`, 'TRANSFER_FAILED');
        }
        pending.stage = 'TRANSFER_SUBMITTED';
        this.updatePendingFinalization(token, pending);
      }

      // Stage: TRANSFER_SUBMITTED → FINALIZED
      if (pending.stage === 'TRANSFER_SUBMITTED') {
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: TRANSFER_SUBMITTED → checking transfer proof...`);
        const transferCommitmentJson = JSON.parse(bundle.transferCommitment);
        const transferCommitment = await TransferCommitment.fromJSON(transferCommitmentJson);
        const proof = await this.quickProofCheck(stClient, trustBase, transferCommitment);
        if (!proof) {
          logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: transfer proof not yet available, staying TRANSFER_SUBMITTED`);
          this.updatePendingFinalization(token, pending);
          return 'pending';
        }
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: transfer proof obtained! Finalizing...`);

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

        // Spend Queue: cache newly confirmed token and wake queued entries
        const resolvedAmount = this.extractCoinAmountForCache(finalizedToken, confirmedToken.coinId);
        if (resolvedAmount > 0n) {
          this.parsedTokenCache.set(tokenId, { token: confirmedToken, sdkToken: finalizedToken, amount: resolvedAmount });
          this.spendQueue.notifyChange(confirmedToken.coinId);
        }

        // History entry was already created in processInstantSplitBundle() — no duplicate here

        // Emit transfer:confirmed so the UI learns about the state change
        this.deps!.emitEvent('transfer:confirmed', {
          id: crypto.randomUUID(),
          status: 'completed',
          tokens: [confirmedToken],
          tokenTransfers: [],
        });

        logger.debug('Payments', `V5 token resolved: ${tokenId.slice(0, 8)}...`);
        return 'resolved';
      }

      return 'pending';
    } catch (error) {
      logger.error('Payments', `resolveV5Token failed for ${tokenId.slice(0, 8)}:`, error);
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
      const localNametag = this.getNametag();
      if (nametagTokens.length === 0 && localNametag?.token) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nametagToken = await SdkToken.fromJSON(localNametag.token) as SdkToken<any>;
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
  /**
   * Memoized (plaintext JSON → CID ref) pair. If successive saves produce
   * identical pendingTokens, we skip the IPFS pin and reuse the last CID.
   * Prevents per-tick CID churn from the 10s resolver when no state has
   * changed (steelman fix #7).
   *
   * Scoped to this module instance; cleared on reset/reconnect via init.
   */
  private _lastPinnedV5Json: string | null = null;
  private _lastPinnedV5Ref: CidRef | null = null;

  private async savePendingV5Tokens(): Promise<void> {
    const pendingTokens: Token[] = [];
    for (const token of this.tokens.values()) {
      if (this.parsePendingFinalization(token.sdkData)) {
        pendingTokens.push(token);
      }
    }
    if (pendingTokens.length === 0) {
      logger.debug('Payments', `[V5-PERSIST] No pending V5 tokens to save (total tokens: ${this.tokens.size}), clearing KV`);
      // Clearing the pending set is operational cleanup after the
      // inbound transfer(s) finalized; not itself a user action.
      await this.setStorageEntry(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS, '', 'cache_index');
      this._lastPinnedV5Json = null;
      this._lastPinnedV5Ref = null;
      return;
    }

    // PROFILE-CID-REFERENCES.md §8.1 — pendingV5 tokens are fat (sdkData
    // can be 5-20 KB per token). When a CidRefStore is available, write
    // a small CID reference to OpLog and pin the content to IPFS. Falls
    // back to legacy inline JSON when CidRefStore is absent.
    const cidRefStore = this.deps!.cidRefStore;
    if (cidRefStore) {
      // Sort keys for deterministic JSON — two consecutive saves with the
      // same token set produce identical JSON regardless of Map insertion order.
      const json = JSON.stringify(pendingTokens);

      // Memoization: skip pin if plaintext is unchanged since last save.
      // AES-GCM uses random IVs so re-pinning identical plaintext would
      // produce a different CID anyway, but we'd rather write the same
      // ref than thrash the gateway.
      if (this._lastPinnedV5Ref && this._lastPinnedV5Json === json) {
        const refStr = CidRefStore.stringifyRef(this._lastPinnedV5Ref);
        logger.debug(
          'Payments',
          `[V5-PERSIST] Pending set unchanged, reusing cached CID ref (cid=${this._lastPinnedV5Ref.cid})`,
        );
        await this.setStorageEntry(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS, refStr, 'token_receive');
        return;
      }

      const ref = await cidRefStore.pinJson(pendingTokens);
      const refStr = CidRefStore.stringifyRef(ref);
      logger.debug(
        'Payments',
        `[V5-PERSIST] Saving ${pendingTokens.length} pending V5 token(s) via CID ref (cid=${ref.cid}, encryptedSize=${ref.size} bytes, OpLog value=${refStr.length} bytes)`,
      );
      await this.setStorageEntry(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS, refStr, 'token_receive');
      // Update memo AFTER successful storage.set so a set-failure does
      // not leave us thinking the CID is live.
      this._lastPinnedV5Json = json;
      this._lastPinnedV5Ref = ref;
      return;
    }

    // Legacy path: inline JSON (deprecated for heavy wallets — see CID-refs doc).
    const json = JSON.stringify(pendingTokens);
    logger.debug(
      'Payments',
      `[V5-PERSIST] Saving ${pendingTokens.length} pending V5 token(s) inline (${json.length} bytes — consider providing cidRefStore)`,
    );
    await this.setStorageEntry(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS, json, 'token_receive');
  }

  /**
   * Load pending V5 tokens from key-value storage and merge into tokens map.
   * Called during load() to restore tokens that TXF format can't represent.
   *
   * PROFILE-CID-REFERENCES.md §6 — dual-read: detect CID-ref via
   * tryParseRef; fall back to legacy inline JSON otherwise.
   *
   * Error handling (steelman-hardened):
   *   - CID ref present but no cidRefStore injected → throws a typed
   *     `ProfileError('CID_REF_UNREADABLE')` so callers can surface a
   *     configuration error rather than silently losing pending transfers.
   *   - IPFS fetch / verify / decrypt errors propagate from the CidRefStore
   *     with their own typed codes — NOT swallowed as "parse failure".
   *   - Legacy-JSON parse failures are caught narrowly (SyntaxError only).
   */
  private async loadPendingV5Tokens(): Promise<void> {
    const data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS);
    logger.debug('Payments', `[V5-PERSIST] loadPendingV5Tokens: KV data = ${data ? `${data.length} bytes` : 'null/empty'}`);
    if (!data) return;

    const ref = CidRefStore.tryParseRef(data);
    let pendingTokens: Token[];

    if (ref) {
      // CID reference path.
      if (!this.deps!.cidRefStore) {
        // Configuration error: a prior session wrote CID refs, this session
        // doesn't have the store needed to resolve them. Throw typed error
        // so the caller can surface to the user rather than silently
        // dropping pending transfers.
        const { ProfileError } = await import('../../profile/errors.js');
        throw new ProfileError(
          'CID_REF_UNREADABLE',
          `PaymentsModule.loadPendingV5Tokens: KV at ${STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS} ` +
            `contains a CID ref (cid=${ref.cid}) but no cidRefStore was injected. ` +
            `Pending V5 transfers cannot be restored without IPFS access. ` +
            `Check PaymentsModule init — is cidRefStore provided?`,
        );
      }
      logger.debug(
        'Payments',
        `[V5-PERSIST] Reading via CID ref (cid=${ref.cid}, encryptedSize=${ref.size})`,
      );
      // Errors from fetchJson (IPFS timeout, CID_REF_SIZE_MISMATCH,
      // DECRYPTION_FAILED) propagate — NOT caught below.
      pendingTokens = await this.deps!.cidRefStore.fetchJson<Token[]>(ref);
    } else {
      // Legacy path: inline JSON (pre-CID-refs wallet). Narrow catch:
      // ONLY swallow SyntaxError from malformed legacy JSON. All other
      // errors propagate with their typed codes.
      try {
        pendingTokens = JSON.parse(data) as Token[];
      } catch (err) {
        if (err instanceof SyntaxError) {
          logger.error('Payments', '[V5-PERSIST] Legacy JSON parse failed (corrupted inline data):', err);
          return;
        }
        throw err;
      }
    }

    if (!Array.isArray(pendingTokens)) {
      // Defensive: a legacy wallet's JSON was the wrong shape.
      logger.error(
        'Payments',
        `[V5-PERSIST] Decoded pendingTokens is not an array (got ${typeof pendingTokens}); skipping load.`,
      );
      return;
    }

    logger.debug(
      'Payments',
      `[V5-PERSIST] Parsed ${pendingTokens.length} pending V5 token(s): ${pendingTokens.map((t) => t.id.slice(0, 16)).join(', ')}`,
    );
    for (const token of pendingTokens) {
      // Only restore if not already in the map (e.g., already resolved)
      if (!this.tokens.has(token.id)) {
        this.tokens.set(token.id, token);
        logger.debug('Payments', `[V5-PERSIST] Restored token ${token.id.slice(0, 16)} (status=${token.status})`);
      } else {
        logger.debug('Payments', `[V5-PERSIST] Token ${token.id.slice(0, 16)} already in map, skipping`);
      }
    }
  }

  /**
   * Persist the set of processed splitGroupIds to KV storage.
   * This ensures Nostr re-deliveries are ignored across page reloads,
   * even when the confirmed token's in-memory ID differs from v5split_{id}.
   */
  private async saveProcessedSplitGroupIds(): Promise<void> {
    const ids = Array.from(this.processedSplitGroupIds);
    if (ids.length > 0) {
      // Dedup ledger — operational state protecting against duplicate
      // Nostr re-deliveries; not itself a user action.
      await this.setStorageEntry(
        STORAGE_KEYS_ADDRESS.PROCESSED_SPLIT_GROUP_IDS,
        JSON.stringify(ids),
        'cache_index',
      );
    }
  }

  /**
   * Load processed splitGroupIds from KV storage.
   */
  private async loadProcessedSplitGroupIds(): Promise<void> {
    const data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.PROCESSED_SPLIT_GROUP_IDS);
    if (!data) return;
    try {
      const ids = JSON.parse(data) as string[];
      for (const id of ids) {
        this.processedSplitGroupIds.add(id);
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
      try {
        const parsed = JSON.parse(token.sdkData);
        const sdkToken = await SdkToken.fromJSON(parsed);
        const amount = this.extractCoinAmountForCache(sdkToken, token.coinId);
        if (amount > 0n) {
          this.parsedTokenCache.set(token.id, { token, sdkToken, amount });
        }
      } catch {
        // Parse failure — token not cached; SpendQueue will skip it during re-evaluation
      }
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
      try {
        const parsed = JSON.parse(token.sdkData);
        const sdkToken = await SdkToken.fromJSON(parsed);
        const amount = this.extractCoinAmountForCache(sdkToken, token.coinId);
        if (amount > 0n) {
          this.parsedTokenCache.set(token.id, { token, sdkToken, amount });
          this.spendQueue.notifyChange(token.coinId);
        }
      } catch { /* parse failure — skip */ }
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
   *
   * **C9 nametag re-resolution defense (T.7.B.5).** Per UXF transfer
   * protocol §3.1, §5.6, §9.3, the unauthenticated `payload.sender.nametag`
   * MUST NOT be displayed in UI without re-resolving against the
   * AUTHENTICATED Nostr signing pubkey via the identity-binding registry.
   * This method is a thin wrapper over
   * {@link resolveSenderInfoViaBinding} (in `./transfer/nametag-reresolver`)
   * which centralizes that policy. The optional `payloadSenderNametag`
   * parameter is accepted for forward-compat with the UXF outer envelope
   * but is NEVER trusted directly — it is logged for forensic correlation
   * with the binding-attested result.
   *
   * Returns:
   *   - `senderAddress` — the binding event's `directAddress`, or
   *     `undefined` if no binding event exists.
   *   - `senderNametag` — the BINDING-ATTESTED nametag, or `undefined`
   *     if no binding event exists OR the binding event registers
   *     pubkey-only (no nametag). NEVER returns the payload claim.
   *   - `senderNametagSource` — `'binding-event'` when a binding was
   *     found (regardless of whether it had a nametag),
   *     `'untrusted-payload'` when the lookup failed. Used by callers
   *     that want to differentiate "known peer (no nametag)" from
   *     "unknown sender" in the UI.
   *
   * @param senderTransportPubkey - The AUTHENTICATED Nostr signing
   *                                pubkey of the sender. Verified by
   *                                the relay; safe to use as the
   *                                lookup key.
   * @param payloadSenderNametag - The unauthenticated nametag claim
   *                               from `payload.sender.nametag` (if
   *                               any). Accepted but never trusted.
   */
  private async resolveSenderInfo(
    senderTransportPubkey: string,
    payloadSenderNametag?: string,
  ): Promise<{
    senderAddress?: string;
    senderNametag?: string;
    senderNametagSource: ReresolvedNametagSource;
  }> {
    return resolveSenderInfoViaBinding(
      senderTransportPubkey,
      payloadSenderNametag,
      this.deps?.transport,
    );
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
        logger.debug('Payments', `Unicity ID minted and saved: ${result.nametagData.name}`);

        // Emit event (use existing nametag:registered event type)
        this.deps!.emitEvent('nametag:registered', {
          nametag: result.nametagData.name,
          addressIndex: 0, // Primary address
        });
      }

      return result;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.debug('Payments', 'mintNametag failed:', errorMsg);
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

      // Preserve nametags — sync providers may not include _nametags in merged data
      const savedNametags = [...this.nametags];

      // Sync with each provider
      for (const [providerId, provider] of providers) {
        try {
          const result = await provider.sync(localData);

          if (result.success && result.merged) {
            // Address guard: reject data from a different address.
            // Stale IPFS records may contain tokens from a previously active
            // address if a write-behind flush raced with an address switch.
            const mergedMeta = (result.merged as TxfStorageDataBase)?._meta;
            const currentL1 = this.deps!.identity.l1Address;
            const currentChain = this.deps!.identity.chainPubkey;
            if (mergedMeta?.address && currentL1 && mergedMeta.address !== currentL1 && mergedMeta.address !== currentChain) {
              logger.warn('Payments', `Sync: rejecting data from provider ${providerId} — address mismatch (got=${mergedMeta.address.slice(0, 20)}... expected=${currentL1.slice(0, 20)}...)`);
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

    for (const token of this.tokens.values()) {
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

  // ===========================================================================
  // T.8.B — Capability hint surfacing (UXF §10.4 + W20)
  // ===========================================================================

  /**
   * Compute the outbound asset kinds carried by a `TransferRequest`.
   *
   * Folds the primary `(coinId, amount)` slot (when present) and every
   * `additionalAssets` entry into the deduplicated set of `'coin' | 'nft' | …`
   * tokens that will ride in the outbound bundle. Future asset kinds (added
   * post-v1.0) are passed through verbatim — the receiver's T.2.B
   * `UNKNOWN_ASSET_KIND` rule polices what's actually accepted.
   */
  private computeOutboundAssetKinds(request: TransferRequest): ReadonlyArray<string> {
    const kinds = new Set<string>();
    if (request.coinId && request.amount) {
      kinds.add('coin');
    }
    if (request.additionalAssets && request.additionalAssets.length > 0) {
      for (const asset of request.additionalAssets) {
        if (asset && typeof asset === 'object' && typeof asset.kind === 'string') {
          kinds.add(asset.kind);
        }
      }
    }
    return Array.from(kinds);
  }

  /**
   * Map the resolved transfer mode to the canonical wire-protocol label
   * advertised in identity binding events (per §10.4 / T.8.B).
   *
   * Mapping (mirrors the dispatcher routing in `send()`):
   *   - UXF conservative + features.senderUxf  → `'uxf-car'`  (CAR-embed)
   *   - UXF instant       + features.senderUxf  → `'uxf-cid'`  (CID-by-ref)
   *   - explicit `'txf'`  + features.senderUxf  → `'txf'`     (legacy TXF)
   *   - any mode          + !features.senderUxf → `'txf'`     (legacy single-token)
   */
  private resolveOutboundWireProtocol(mode: 'instant' | 'conservative' | 'txf'): string {
    if (!this.features.senderUxf) return 'txf';
    if (mode === 'conservative') return 'uxf-car';
    if (mode === 'instant') return 'uxf-cid';
    return 'txf';
  }

  /**
   * T.8.B — Pre-send capability hint check.
   *
   * Resolves the recipient via the transport, inspects the binding event's
   * capability hints, and emits `transfer:capability-warning` when the
   * outbound bundle's asset kinds or wire protocol are not advertised by
   * the peer. **DOES NOT** auto-strip, auto-coerce, or block the send —
   * the warning is informational and the actual interop guarantee comes
   * from the receiver's T.2.B `UNKNOWN_ASSET_KIND` reject rule and the
   * §10.4 forward-compat behaviour.
   *
   * W20: if the peer's binding event is silent about `assetKinds`, treat
   * the peer as `['coin']` (older v1.0 wallet pre-dating NFTs). Any
   * outbound NFT entry will then trigger a warning.
   *
   * Failure modes (all silent — capability hints are best-effort):
   *  - Resolve returns null (unknown peer): skip the check entirely.
   *  - Both `wireProtocols` and `assetKinds` absent: skip emission unless
   *    an outbound asset kind is OUTSIDE the W20 default `['coin']`.
   *  - Resolve throws: caller logs and continues (see `send()`).
   */
  private async maybeEmitCapabilityWarning(
    request: TransferRequest,
    mode: 'instant' | 'conservative' | 'txf',
  ): Promise<void> {
    const transport = this.deps?.transport;
    if (!transport?.resolve) return;

    let peerInfo: PeerInfo | null;
    try {
      peerInfo = (await transport.resolve(request.recipient)) ?? null;
    } catch {
      // Resolve failures aren't capability concerns — let the dispatcher
      // surface its own typed error.
      return;
    }
    if (!peerInfo) return;

    const outboundAssetKinds = this.computeOutboundAssetKinds(request);
    const outboundWireProtocol = this.resolveOutboundWireProtocol(mode);

    // W20: assetKinds absent on the wire ⇒ assume ['coin']. We preserve
    // the empty-array case (peer present but explicitly empty) as-is so
    // diagnostics distinguish "older peer" from "explicitly empty".
    const recipientAssetKinds: ReadonlyArray<string> = peerInfo.assetKinds
      ?? DEFAULT_ASSET_KINDS_WHEN_ABSENT;
    const recipientWireProtocols = peerInfo.wireProtocols;

    const advertisedKinds = new Set(recipientAssetKinds);
    const mismatchedAssetKinds = outboundAssetKinds.filter(k => !advertisedKinds.has(k));

    // wireProtocolMismatch fires only when hints were PRESENT and the
    // outbound protocol is not in the set. Absent hints make NO claim.
    let wireProtocolMismatch = false;
    if (recipientWireProtocols !== undefined) {
      const advertisedWP = new Set(recipientWireProtocols);
      wireProtocolMismatch = !advertisedWP.has(outboundWireProtocol);
    }

    if (mismatchedAssetKinds.length === 0 && !wireProtocolMismatch) {
      return; // Everything advertised — nothing to warn about.
    }

    this.deps!.emitEvent('transfer:capability-warning', {
      recipientTransportPubkey: peerInfo.transportPubkey,
      recipientAssetKinds,
      recipientWireProtocols,
      outboundAssetKinds,
      outboundWireProtocol,
      mismatchedAssetKinds,
      wireProtocolMismatch,
    });
  }

  // ===========================================================================
  // Symbol → canonical hex coinId resolution (shared by all dispatchers)
  // ===========================================================================

  /**
   * Resolve a short ticker symbol (e.g. `'UCT'`) to the canonical 64/68-char
   * hex `coinId` used by token storage and `validateTargets`.
   *
   * Background: swap manifests and public callers may pass a human-readable
   * symbol such as `'UCT'` or `'USDU'` in `request.coinId`, whereas the
   * internal token map stores tokens under the hex coin identifier produced
   * by the aggregator.  When the literal value finds no match in the in-
   * memory token pool, and the value is short enough to be a symbol (≤ 20
   * characters), the method falls back to the {@link TokenRegistry} singleton
   * to attempt a symbol → id lookup.  If that also fails the original value
   * is returned unchanged (the downstream validator will produce an
   * informative error).
   *
   * Multi-asset awareness: the primary `coinId` field AND each `kind: 'coin'`
   * entry inside `additionalAssets` are resolved independently.  NFT entries
   * (`kind: 'nft'`) carry a `tokenId`, not a `coinId`, and are left untouched.
   *
   * **Must be called BEFORE {@link requireLegacyCoinSlot}** so the narrowing
   * shim sees the canonical hex value and does not re-widen it.
   *
   * This is the single canonical implementation of the pattern that the legacy
   * `instantSplitSend` arm previously inlined at two call-sites (lines
   * ~1868 and ~2440).  Those sites now delegate here so the logic lives in one
   * place.
   */
  private resolveCoinIdSymbol(request: TransferRequest): TransferRequest {
    // ── Primary coinId slot ───────────────────────────────────────────────────
    const rawCoinId = request.coinId;
    let resolvedCoinId = rawCoinId;
    if (rawCoinId !== undefined && rawCoinId !== null) {
      const literalMatch = Array.from(this.tokens.values()).some(
        (t) => t.coinId === rawCoinId,
      );
      if (!literalMatch && rawCoinId.length <= 20) {
        const def = TokenRegistry.getInstance().getDefinitionBySymbol(rawCoinId);
        if (def?.id) {
          resolvedCoinId = def.id;
        }
      }
    }

    // ── additionalAssets coin entries ─────────────────────────────────────────
    let resolvedAdditional: TransferRequest['additionalAssets'] =
      request.additionalAssets;
    if (request.additionalAssets && request.additionalAssets.length > 0) {
      const mapped = request.additionalAssets.map((asset) => {
        if (asset.kind !== 'coin') return asset; // NFT entries: untouched
        const raw = asset.coinId;
        const litMatch = Array.from(this.tokens.values()).some(
          (t) => t.coinId === raw,
        );
        if (!litMatch && raw.length <= 20) {
          const def = TokenRegistry.getInstance().getDefinitionBySymbol(raw);
          if (def?.id) {
            return { ...asset, coinId: def.id };
          }
        }
        return asset;
      });
      // Only allocate a new array if something actually changed.
      const changed = mapped.some(
        (a, i) => a !== request.additionalAssets![i],
      );
      if (changed) {
        resolvedAdditional = mapped as TransferRequest['additionalAssets'];
      }
    }

    // Return the original object when nothing changed (avoids spurious spread).
    if (resolvedCoinId === rawCoinId && resolvedAdditional === request.additionalAssets) {
      return request;
    }
    return {
      ...request,
      ...(resolvedCoinId !== rawCoinId ? { coinId: resolvedCoinId } : {}),
      ...(resolvedAdditional !== request.additionalAssets
        ? { additionalAssets: resolvedAdditional }
        : {}),
    };
  }

  // ===========================================================================
  // T.2.D.1 — UXF conservative-mode dispatcher
  // ===========================================================================

  /**
   * UXF conservative-mode send dispatcher (T.2.D.1, flag-gated).
   *
   * Reached only when `features.senderUxf === true` AND
   * `transferMode === 'conservative'`. Builds the {@link
   * ConservativeSenderDeps} surface from the module's existing private
   * state (oracle, transport, identity, spend planner, SDK helpers) and
   * delegates the §4.2 sender pipeline to {@link sendConservativeUxf}.
   *
   * **Stub outbox writer**: this dispatcher uses the existing legacy
   * `saveToOutbox`/`removeFromOutbox` chain so existing tests keep
   * their invariants. T.2.D.2 replaces this with the per-entry-key
   * UXF outbox writer.
   *
   * Restrictions inherited from T.1.B.1's `requireLegacyCoinSlot`:
   *  - The request MUST carry a primary `(coinId, amount)` slot. NFT-only
   *    and multi-asset shapes are accepted by the public type but
   *    rejected here until T.2.B's source-selection extension lands.
   */
  private async dispatchUxfConservativeSend(
    originalRequest: TransferRequest,
  ): Promise<TransferResult> {
    // ── Symbol → hex coinId resolution (must run BEFORE requireLegacyCoinSlot) ─
    const request: LegacyCoinTransferRequest = requireLegacyCoinSlot(
      this.resolveCoinIdSymbol(originalRequest),
    );

    // Resolve recipient + recipient address up front so the orchestrator
    // gets a fully-typed PeerInfo. This also serves the same identity-
    // binding/UI affordance the legacy arm provides.
    const peerInfo: PeerInfo | null =
      (await this.deps!.transport.resolve?.(request.recipient)) ?? null;
    const recipientPubkey = this.resolveTransportPubkey(request.recipient, peerInfo);
    const recipientAddress = await this.resolveRecipientAddress(
      request.recipient,
      request.addressMode,
      peerInfo,
    );

    // Synthesize a PeerInfo if `transport.resolve` returned null — the
    // orchestrator only needs `transportPubkey` and (optional) `nametag`.
    const recipient: PeerInfo = peerInfo ?? {
      transportPubkey: recipientPubkey,
      chainPubkey: '',
      l1Address: '',
      directAddress: '',
      timestamp: Date.now(),
    };

    // Pre-build SDK helpers reused across all commitments. (Identical
    // to the legacy conservative arm — single signing service +
    // single state-transition client.)
    const signingService = await this.createSigningService();
    const stClient = this.deps!.oracle.getStateTransitionClient?.() as
      | StateTransitionClient
      | undefined;
    if (!stClient) {
      throw new SphereError(
        'State transition client not available. Oracle provider must implement getStateTransitionClient()',
        'AGGREGATOR_ERROR',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trustBase = (this.deps!.oracle as any).getTrustBase?.();
    if (!trustBase) {
      throw new SphereError(
        'Trust base not available. Oracle provider must implement getTrustBase()',
        'AGGREGATOR_ERROR',
      );
    }

    const onChainMessage = parseInvoiceMemoForOnChain(
      request.memo,
      request.invoiceRefundAddress,
      request.invoiceContact,
    );

    const transferId = crypto.randomUUID();
    const committedOnChainTokenIds = new Set<string>();

    const deps: ConservativeSenderDeps = {
      aggregator: this.deps!.oracle,
      transport: this.deps!.transport,
      tokenStorage: null,
      identity: this.deps!.identity,
      senderTransportPubkey: this.deps!.identity.chainPubkey,
      emit: (type, data) => this.deps!.emitEvent(type, data),
      // T.2.D.1 keeps publishToIpfs unwired; CID-bound delivery is
      // T.4.A's responsibility. Tests inject a real publisher.
      availableSources: () => Array.from(this.tokens.values()),
      transferId,
      selectSources: async ({ request: req }) => {
        const out: Token[] = [];

        // ── Primary coin ──────────────────────────────────────────────────────
        const parsedPool = await this.spendPlanner.buildParsedPool(
          Array.from(this.tokens.values()),
          request.coinId,
        );
        let pendingChangeAmount = 0n;
        for (const [, t] of this.tokens) {
          if (t.coinId === request.coinId && t.status === 'transferring') {
            pendingChangeAmount += BigInt(t.amount || '0');
          }
        }
        // Use a per-coin reservation id so additional-coin plans never
        // collide in SpendQueue.promises (which is keyed by entry id).
        const primaryQueueId = `${transferId}:${request.coinId}`;
        const planResult = this.spendPlanner.planSend(
          { amount: req.amount ?? '0', coinId: request.coinId },
          parsedPool,
          this.reservationLedger,
          this.spendQueue,
          primaryQueueId,
          pendingChangeAmount,
        );
        let splitPlan: SplitPlan;
        if (planResult === 'queued') {
          const queueResult = await this.spendQueue.waitForEntry(primaryQueueId);
          splitPlan = queueResult.splitPlan;
        } else {
          splitPlan = planResult.splitPlan;
        }
        out.push(...splitPlan.tokensToTransferDirectly.map((t) => t.uiToken));
        if (splitPlan.tokenToSplit) out.push(splitPlan.tokenToSplit.uiToken);

        // ── Additional assets (coin entries only) ─────────────────────────────
        // Each additional coin is planned independently with a unique
        // queue id (${transferId}:${addCoinId}:${i}) to prevent promise-map
        // collisions when two entries queue for the same SpendQueue.
        const additional = req.additionalAssets ?? [];
        for (let i = 0; i < additional.length; i++) {
          const asset = additional[i];
          if (asset.kind !== 'coin') continue; // NFT: whole-token, handled by commitSources
          const addCoinId = asset.coinId;
          const addParsedPool = await this.spendPlanner.buildParsedPool(
            Array.from(this.tokens.values()),
            addCoinId,
          );
          let addPendingChange = 0n;
          for (const [, t] of this.tokens) {
            if (t.coinId === addCoinId && t.status === 'transferring') {
              addPendingChange += BigInt(t.amount || '0');
            }
          }
          const addQueueId = `${transferId}:${addCoinId}:${i}`;
          const addPlanResult = this.spendPlanner.planSend(
            { amount: asset.amount, coinId: addCoinId },
            addParsedPool,
            this.reservationLedger,
            this.spendQueue,
            addQueueId,
            addPendingChange,
          );
          let addSplitPlan: SplitPlan;
          if (addPlanResult === 'queued') {
            const addQueueResult = await this.spendQueue.waitForEntry(addQueueId);
            addSplitPlan = addQueueResult.splitPlan;
          } else {
            addSplitPlan = addPlanResult.splitPlan;
          }
          out.push(...addSplitPlan.tokensToTransferDirectly.map((t) => t.uiToken));
          if (addSplitPlan.tokenToSplit) out.push(addSplitPlan.tokenToSplit.uiToken);
        }

        // [DIAG-UXF-SEND] all sources selected across primary + additionalAssets
        logger.debug('Payments', '[DIAG-UXF-SEND] selectSources result', {
          totalSelected: out.length,
          selectedIds: out.map((t) => `${t.id.slice(0, 12)}(${t.coinId.slice(0, 12)})`),
          primaryCoinId: request.coinId.slice(0, 16),
          additionalCount: (req.additionalAssets ?? []).filter((a) => a.kind === 'coin').length,
        });
        // Mark all selected sources as transferring + persist (matches legacy
        // semantics — prevents double-spend within the same session).
        for (const tok of out) {
          tok.status = 'transferring';
          this.tokens.set(tok.id, tok);
          this.parsedTokenCache.delete(tok.id);
        }
        await this.save();
        return out;
      },
      preflightOptions: () => ({
        // T.2.A wraps the existing aggregator path; for the dispatcher
        // we fall through with a noop extractor since the legacy
        // single-coin path's tokens are always finalized at selection.
        // T.2.D.2 + T.5 wires the real chain extractor. The orchestrator
        // accepts an empty chain → no-op preflight.
        resolveRequestId: () => {
          throw new SphereError(
            'preflight resolveRequestId invoked unexpectedly in T.2.D.1 dispatcher',
            'INVALID_CONFIG',
          );
        },
        extractPendingChain: () => [],
      }),
      commitSources: async ({ sources }) => {
        // [DIAG-UXF-SEND] how many source tokens are being committed?
        logger.debug('Payments', '[DIAG-UXF-SEND] commitSources entry', {
          sourceCount: sources.length,
          sourceIds: sources.map((t) => `${t.id.slice(0, 12)}(${t.coinId.slice(0, 12)})`),
        });
        const out: ConservativeCommitResult[] = [];
        for (const token of sources) {
          // The legacy arm splits-then-mints for the source-to-be-split,
          // and direct-transfers for everything else. The orchestrator's
          // SDK-coupling boundary is THIS callback — we re-implement the
          // direct-conservative path here verbatim to match existing
          // behavior. Split-mode is currently unsupported by the
          // orchestrator (T.2.D.2 widens it via OutboxWriter).
          const commitment = await this.createSdkCommitment(
            token,
            recipientAddress,
            signingService,
            onChainMessage,
          );
          const submitResponse = await stClient.submitTransferCommitment(commitment);
          if (
            submitResponse.status !== 'SUCCESS' &&
            submitResponse.status !== 'REQUEST_ID_EXISTS'
          ) {
            throw new SphereError(
              `Transfer commitment failed: ${submitResponse.status}`,
              'TRANSFER_FAILED',
            );
          }
          committedOnChainTokenIds.add(token.id);
          const inclusionProof = await waitInclusionProof(trustBase, stClient, commitment);
          const transferTx = commitment.toTransaction(inclusionProof);
          // Reconstruct the recipient-token JSON shape (sourceToken +
          // post-transfer transition) for ingestion into the bundle.
          const tokenJson = token.sdkData
            ? (typeof token.sdkData === 'string' ? JSON.parse(token.sdkData) : token.sdkData)
            : null;
          if (!tokenJson || typeof tokenJson !== 'object') {
            throw new SphereError(
              `Token ${token.id} missing sdkData; cannot ingest into UXF bundle`,
              'TRANSFER_FAILED',
            );
          }
          const recipientTokenJson = {
            ...(tokenJson as Record<string, unknown>),
            transactions: [
              ...(((tokenJson as { transactions?: unknown[] }).transactions) ?? []),
              transferTx.toJSON(),
            ],
          };
          const requestIdBytes = commitment.requestId;
          const requestIdHex =
            requestIdBytes instanceof Uint8Array
              ? Array.from(requestIdBytes)
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join('')
              : (typeof (requestIdBytes as { toJSON?: () => string }).toJSON === "function" ? (requestIdBytes as { toJSON: () => string }).toJSON() : String(requestIdBytes));
          out.push({
            sourceTokenId: token.id,
            method: 'direct',
            requestIdHex,
            recipientTokenJson,
          });
          await this.removeToken(token.id, transferId);
        }
        return out;
      },
      outbox: {
        // T.2.D.2 — orchestrator drives §7.0 via create/transition.
        // Until the per-entry-key OutboxWriter (T.6.A) is fully wired
        // to a ProfileDatabase in PaymentsModule (T.6.D, follow-up),
        // this adapter folds the new hooks onto the legacy
        // saveToOutbox / removeFromOutbox chain so existing tests keep
        // their invariants:
        //   - create (status=packaging): persist legacy synthetic entry.
        //   - transition (status=delivered): drop legacy entry.
        //   - transition (other states): no-op (legacy outbox is
        //     bundle-grained-on-create, terminal-on-removal only).
        create: async (entry) => {
          const synthResult: TransferResult = {
            id: entry.id,
            status: 'submitted',
            tokens: [],
            tokenTransfers: [],
          };
          await this.saveToOutbox(synthResult, entry.recipientTransportPubkey);
        },
        transition: async (id, patch) => {
          if (patch.status === 'delivered') {
            await this.removeFromOutbox(id);
          }
          // 'pinned' / 'sending' / 'failed-transient' carry no legacy
          // state mutation — the new schema's intermediate states are
          // tracked exclusively by the (forthcoming) OutboxWriter.
        },
      },
    };

    return sendConservativeUxf(originalRequest, recipient, deps);
  }

  // ===========================================================================
  // T.5.A — UXF instant-mode dispatcher
  // ===========================================================================

  /**
   * UXF instant-mode send dispatcher (T.5.A, flag-gated).
   *
   * Reached only when `features.senderUxf === true` AND
   * `transferMode === 'instant'`. Mirrors {@link
   * dispatchUxfConservativeSend} structurally, but delegates to {@link
   * sendInstantUxf} which DOES NOT await inclusion proofs before
   * publishing — proofs are filled in by T.5.B's sender-side
   * finalization worker (deferred to a future wave).
   *
   * Restrictions inherited from {@link requireLegacyCoinSlot}:
   *  - The request MUST carry a primary `(coinId, amount)` slot until
   *    the multi-asset source-selection extension lands.
   */
  private async dispatchUxfInstantSend(
    originalRequest: TransferRequest,
  ): Promise<TransferResult> {
    // ── Symbol → hex coinId resolution (must run BEFORE requireLegacyCoinSlot) ─
    const request: LegacyCoinTransferRequest = requireLegacyCoinSlot(
      this.resolveCoinIdSymbol(originalRequest),
    );

    const peerInfo: PeerInfo | null =
      (await this.deps!.transport.resolve?.(request.recipient)) ?? null;
    const recipientPubkey = this.resolveTransportPubkey(request.recipient, peerInfo);
    const recipientAddress = await this.resolveRecipientAddress(
      request.recipient,
      request.addressMode,
      peerInfo,
    );

    const recipient: PeerInfo = peerInfo ?? {
      transportPubkey: recipientPubkey,
      chainPubkey: '',
      l1Address: '',
      directAddress: '',
      timestamp: Date.now(),
    };

    const signingService = await this.createSigningService();
    const stClient = this.deps!.oracle.getStateTransitionClient?.() as
      | StateTransitionClient
      | undefined;
    if (!stClient) {
      throw new SphereError(
        'State transition client not available. Oracle provider must implement getStateTransitionClient()',
        'AGGREGATOR_ERROR',
      );
    }

    const onChainMessage = parseInvoiceMemoForOnChain(
      request.memo,
      request.invoiceRefundAddress,
      request.invoiceContact,
    );

    const transferId = crypto.randomUUID();

    // Derive the address-scoped outbox key prefix per
    // PROFILE-ARCHITECTURE §10.12. Falls back to the chainPubkey itself
    // when the wallet has no DIRECT address (test paths).
    const directForId = this.deps!.identity.directAddress;
    const addressId =
      typeof directForId === 'string' && directForId.length > 0
        ? computeAddressId(directForId)
        : this.deps!.identity.chainPubkey;

    const deps: InstantSenderDeps = {
      aggregator: this.deps!.oracle,
      transport: this.deps!.transport,
      tokenStorage: null,
      identity: this.deps!.identity,
      addressId,
      senderTransportPubkey: this.deps!.identity.chainPubkey,
      emit: (type, data) => this.deps!.emitEvent(type, data),
      availableSources: () => Array.from(this.tokens.values()),
      transferId,
      selectSources: async ({ request: req }) => {
        const parsedPool = await this.spendPlanner.buildParsedPool(
          Array.from(this.tokens.values()),
          request.coinId,
        );
        let pendingChangeAmount = 0n;
        for (const [, t] of this.tokens) {
          if (t.coinId === request.coinId && t.status === 'transferring') {
            pendingChangeAmount += BigInt(t.amount || '0');
          }
        }
        const planResult = this.spendPlanner.planSend(
          { amount: req.amount ?? '0', coinId: request.coinId },
          parsedPool,
          this.reservationLedger,
          this.spendQueue,
          transferId,
          pendingChangeAmount,
        );
        let splitPlan: SplitPlan;
        if (planResult === 'queued') {
          const queueResult = await this.spendQueue.waitForEntry(transferId);
          splitPlan = queueResult.splitPlan;
        } else {
          splitPlan = planResult.splitPlan;
        }
        const out: Token[] = splitPlan.tokensToTransferDirectly.map(
          (t) => t.uiToken,
        );
        if (splitPlan.tokenToSplit) out.push(splitPlan.tokenToSplit.uiToken);
        for (const tok of out) {
          tok.status = 'transferring';
          this.tokens.set(tok.id, tok);
          this.parsedTokenCache.delete(tok.id);
        }
        await this.save();
        return out;
      },
      commitSources: async ({ sources }) => {
        const out: InstantCommitResult[] = [];
        for (const token of sources) {
          // Submit the commitment WITHOUT awaiting the inclusion
          // proof — the canonical instant-mode pipeline.
          const commitment = await this.createSdkCommitment(
            token,
            recipientAddress,
            signingService,
            onChainMessage,
          );
          const submitResponse = await stClient.submitTransferCommitment(commitment);
          if (
            submitResponse.status !== 'SUCCESS' &&
            submitResponse.status !== 'REQUEST_ID_EXISTS'
          ) {
            throw new SphereError(
              `Transfer commitment failed: ${submitResponse.status}`,
              'TRANSFER_FAILED',
            );
          }
          // The transfer transaction goes on the bundle WITHOUT a
          // proof — the recipient's reader walks the chain when
          // proofs land.
          //
          // Use commitment.toJSON().transactionData (NOT commitment.toJSON())
          // because TransferCommitment.toJSON() returns
          // { authenticator, requestId, transactionData } — a Commitment
          // envelope — whereas the UXF deconstruct code expects `tx.data`
          // to be the flat TransferTransactionData shape
          // { sourceState, recipient, salt, recipientDataHash, message, nametags }.
          // Passing the commitment envelope causes every scalar field to be
          // `undefined`, which @ipld/dag-cbor rejects at encode time with
          // "undefined is not supported by the IPLD Data Model".
          const transferTxJson = {
            data: commitment.toJSON().transactionData,
            inclusionProof: null,
          };
          const tokenJson = token.sdkData
            ? typeof token.sdkData === 'string'
              ? JSON.parse(token.sdkData)
              : token.sdkData
            : null;
          if (!tokenJson || typeof tokenJson !== 'object') {
            throw new SphereError(
              `Token ${token.id} missing sdkData; cannot ingest into UXF bundle`,
              'TRANSFER_FAILED',
            );
          }
          const recipientTokenJson = {
            ...(tokenJson as Record<string, unknown>),
            transactions: [
              ...(((tokenJson as { transactions?: unknown[] }).transactions) ?? []),
              transferTxJson,
            ],
          };
          const requestIdBytes = commitment.requestId;
          const requestIdHex =
            requestIdBytes instanceof Uint8Array
              ? Array.from(requestIdBytes)
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join('')
              : (typeof (requestIdBytes as { toJSON?: () => string }).toJSON === "function" ? (requestIdBytes as { toJSON: () => string }).toJSON() : String(requestIdBytes));

          // Phase 9.6.D — store per-requestId context for the finalization
          // worker resolver. `transactionHash` is the commitment's requestId
          // DataHash imprint hex (68 chars = 2-byte algorithm prefix +
          // 32-byte digest), which the aggregator proof will also carry in its
          // `transactionHash` field — enabling race-lost detection at §6.1.
          // `authenticator` is the authenticator signature hex, used by §6.3
          // same-value vs different-value resolution.
          if (this.finalizationWorkerSender !== null) {
            const txHash =
              typeof (requestIdBytes as { toJSON?: () => string }).toJSON === 'function'
                ? (requestIdBytes as { toJSON: () => string }).toJSON()
                : requestIdHex;
            const commitJson = (commitment as { toJSON?: () => { authenticator?: { signature?: string } } }).toJSON?.();
            const authenticatorHex = commitJson?.authenticator?.signature ?? '';
            this._senderRequestContextMap.set(requestIdHex, {
              transactionHash: txHash,
              authenticator: authenticatorHex,
              nextEntryRest: { status: 'valid' as const },
            });
          }

          // Class discrimination per C11. Read sdkData's coinData to
          // route NFTs (whole-token transfer; no splitParent) vs
          // coins (splitParent set on the child).
          const sourceTokenLike = {
            id: token.id,
            coins: (() => {
              try {
                const parsed = JSON.parse(
                  typeof token.sdkData === 'string'
                    ? token.sdkData
                    : JSON.stringify(token.sdkData ?? {}),
                ) as {
                  genesis?: {
                    data?: {
                      coinData?: ReadonlyArray<readonly [string, string]> | null;
                    };
                  };
                };
                const cd = parsed?.genesis?.data?.coinData;
                if (!Array.isArray(cd) || cd.length === 0) return null;
                const coins = cd
                  .filter(
                    (e): e is readonly [string, string] =>
                      Array.isArray(e) && e.length === 2 &&
                      typeof e[0] === 'string' && typeof e[1] === 'string',
                  )
                  .map(([cid, amt]) => ({ coinId: cid, amount: BigInt(amt) }))
                  .filter((c) => c.amount > 0n);
                return coins.length > 0 ? coins : null;
              } catch {
                return [{ coinId: token.coinId, amount: BigInt(token.amount || '0') }];
              }
            })(),
          };
          const tokenClass = classifyTokenLike(sourceTokenLike);

          if (tokenClass === 'coin') {
            out.push({
              sourceTokenId: token.id,
              method: 'direct',
              requestIdHex,
              recipientTokenJson,
              tokenClass: 'coin',
              splitParentTokenId: token.id,
            });
          } else {
            out.push({
              sourceTokenId: token.id,
              method: 'direct',
              requestIdHex,
              recipientTokenJson,
              tokenClass: 'nft',
            });
          }
        }
        return out;
      },
      // markSourcePending — production wiring would mark sources
      // 'pending' here. The existing legacy path's spendPlanner
      // already sets `status='transferring'`; T.5.B will pivot the
      // status to the canonical 'pending' enum once the worker lands.
      markSourcePending: async () => {
        // No-op for T.5.A — selectSources above already marks sources
        // `transferring` in the local cache.
      },
      // Phase 9.6.D — wire the in-memory outbox so the instant-sender
      // persists `delivered-instant` entries the finalization worker can
      // read via its injected FinalizationOutboxWriter. When no worker is
      // installed, fall through to `undefined` (original T.5.A behaviour).
      outbox: this.finalizationWorkerSender !== null
        ? {
            write: async (entry) => {
              const existing = this._senderOutboxMap.get(entry.id);
              this._senderOutboxMap.set(entry.id, {
                ...entry,
                _schemaVersion: 'uxf-1' as const,
                lamport: (existing?.lamport ?? 0) + 1,
              });
            },
          }
        : undefined,
      // Phase 9.6.D — trigger finalization after `delivered-instant`.
      // Fire-and-forget: any throw from processOne is logged, not
      // propagated — the publish has already completed and the outbox
      // entry holds the canonical state.
      onTriggerFinalization: this.finalizationWorkerSender !== null
        ? async ({ outboxId }) => {
            const entry = this._senderOutboxMap.get(outboxId);
            if (entry !== undefined && this.finalizationWorkerSender !== null) {
              void this.finalizationWorkerSender.processOne(entry).catch((err) => {
                logger.debug(
                  'Payments',
                  `FinalizationWorkerSender.processOne error for outbox ${outboxId}: ${err}`,
                );
              });
            }
          }
        : undefined,
    };

    return sendInstantUxf(originalRequest, recipient, deps);
  }

  // ===========================================================================
  // T.7.A — UXF TXF-mode dispatcher
  // ===========================================================================

  /**
   * Legacy TXF send dispatcher (T.7.A, flag-gated).
   *
   * Reached only when `features.senderUxf === true` AND
   * `transferMode === 'txf'`. Delegates the §4.4.1 / §4.4.2 sequence
   * to {@link sendTxfUxf}. The orchestrator emits ONE Nostr event per
   * token (no UXF bundle) and persists per-token outbox entries with
   * synthetic `bundleCid='txf-' + sourceTokenId` and
   * `deliveryMethod='txf-legacy'`.
   *
   * Restrictions inherited from {@link requireLegacyCoinSlot}:
   *  - The request MUST carry a primary `(coinId, amount)` slot until
   *    the multi-asset source-selection extension lands. NFT-only TXF
   *    is out of scope for v1.0.
   *
   * @param originalRequest  the public TransferRequest.
   * @param txfFinalization  `'conservative'` (default per §10.1) or
   *                         `'instant'` (instant-TXF per §4.4.2).
   */
  private async dispatchTxfSend(
    originalRequest: TransferRequest,
    txfFinalization: TxfFinalization,
  ): Promise<TransferResult> {
    // ── Symbol → hex coinId resolution (must run BEFORE requireLegacyCoinSlot) ─
    const request: LegacyCoinTransferRequest = requireLegacyCoinSlot(
      this.resolveCoinIdSymbol(originalRequest),
    );

    // Resolve recipient up front so the orchestrator gets a fully-typed
    // PeerInfo. Identical pattern to the UXF dispatchers.
    const peerInfo: PeerInfo | null =
      (await this.deps!.transport.resolve?.(request.recipient)) ?? null;
    const recipientPubkey = this.resolveTransportPubkey(request.recipient, peerInfo);
    const recipientAddress = await this.resolveRecipientAddress(
      request.recipient,
      request.addressMode,
      peerInfo,
    );

    const recipient: PeerInfo = peerInfo ?? {
      transportPubkey: recipientPubkey,
      chainPubkey: '',
      l1Address: '',
      directAddress: '',
      timestamp: Date.now(),
    };

    const signingService = await this.createSigningService();
    const stClient = this.deps!.oracle.getStateTransitionClient?.() as
      | StateTransitionClient
      | undefined;
    if (!stClient) {
      throw new SphereError(
        'State transition client not available. Oracle provider must implement getStateTransitionClient()',
        'AGGREGATOR_ERROR',
      );
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trustBase = (this.deps!.oracle as any).getTrustBase?.();
    if (!trustBase && txfFinalization === 'conservative') {
      // Trust base is only required for conservative (await proof) —
      // instant variant skips waitInclusionProof entirely.
      throw new SphereError(
        'Trust base not available. Oracle provider must implement getTrustBase()',
        'AGGREGATOR_ERROR',
      );
    }

    const onChainMessage = parseInvoiceMemoForOnChain(
      request.memo,
      request.invoiceRefundAddress,
      request.invoiceContact,
    );

    const transferId = crypto.randomUUID();

    // Address id derivation — same rule as the instant dispatcher.
    const directForId = this.deps!.identity.directAddress;
    const addressId =
      typeof directForId === 'string' && directForId.length > 0
        ? computeAddressId(directForId)
        : this.deps!.identity.chainPubkey;

    const deps: TxfSenderDeps = {
      aggregator: this.deps!.oracle,
      transport: this.deps!.transport,
      tokenStorage: null,
      identity: this.deps!.identity,
      addressId,
      senderTransportPubkey: this.deps!.identity.chainPubkey,
      emit: (type, data) => this.deps!.emitEvent(type, data),
      availableSources: () => Array.from(this.tokens.values()),
      transferId,
      selectSources: async ({ request: req }) => {
        const parsedPool = await this.spendPlanner.buildParsedPool(
          Array.from(this.tokens.values()),
          request.coinId,
        );
        let pendingChangeAmount = 0n;
        for (const [, t] of this.tokens) {
          if (t.coinId === request.coinId && t.status === 'transferring') {
            pendingChangeAmount += BigInt(t.amount || '0');
          }
        }
        const planResult = this.spendPlanner.planSend(
          { amount: req.amount ?? '0', coinId: request.coinId },
          parsedPool,
          this.reservationLedger,
          this.spendQueue,
          transferId,
          pendingChangeAmount,
        );
        let splitPlan: SplitPlan;
        if (planResult === 'queued') {
          const queueResult = await this.spendQueue.waitForEntry(transferId);
          splitPlan = queueResult.splitPlan;
        } else {
          splitPlan = planResult.splitPlan;
        }
        const out: Token[] = splitPlan.tokensToTransferDirectly.map(
          (t) => t.uiToken,
        );
        if (splitPlan.tokenToSplit) out.push(splitPlan.tokenToSplit.uiToken);
        for (const tok of out) {
          tok.status = 'transferring';
          this.tokens.set(tok.id, tok);
          this.parsedTokenCache.delete(tok.id);
        }
        await this.save();
        return out;
      },
      commitSources: async ({ sources }) => {
        const out: TxfCommitResult[] = [];
        for (const token of sources) {
          // Build commitment. Same SDK call for both finalization
          // variants — the difference is whether we await the
          // inclusion proof inline (conservative) or attach `null`
          // and let the worker poll later (instant).
          const commitment = await this.createSdkCommitment(
            token,
            recipientAddress,
            signingService,
            onChainMessage,
          );
          const submitResponse = await stClient.submitTransferCommitment(commitment);
          if (
            submitResponse.status !== 'SUCCESS' &&
            submitResponse.status !== 'REQUEST_ID_EXISTS'
          ) {
            throw new SphereError(
              `Transfer commitment failed: ${submitResponse.status}`,
              'TRANSFER_FAILED',
            );
          }

          const sourceTokenJson = token.sdkData
            ? typeof token.sdkData === 'string'
              ? token.sdkData
              : JSON.stringify(token.sdkData)
            : null;
          if (sourceTokenJson === null) {
            throw new SphereError(
              `Token ${token.id} missing sdkData; cannot ship via TXF`,
              'TRANSFER_FAILED',
            );
          }

          let transferTxJson: string;
          if (txfFinalization === 'conservative') {
            // Await the inclusion proof and attach to the transferTx.
            const inclusionProof = await waitInclusionProof(trustBase, stClient, commitment);
            const transferTx = commitment.toTransaction(inclusionProof);
            transferTxJson = JSON.stringify(transferTx.toJSON());
          } else {
            // Instant: ship the commitment with `inclusionProof: null`.
            transferTxJson = JSON.stringify({
              data: commitment.toJSON(),
              inclusionProof: null,
            });
          }

          const requestIdBytes = commitment.requestId;
          const requestIdHex =
            requestIdBytes instanceof Uint8Array
              ? Array.from(requestIdBytes)
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join('')
              : (typeof (requestIdBytes as { toJSON?: () => string }).toJSON === "function" ? (requestIdBytes as { toJSON: () => string }).toJSON() : String(requestIdBytes));

          // Class discrimination per C11 — read sdkData's coinData.
          const sourceTokenLike = {
            id: token.id,
            coins: (() => {
              try {
                const parsed = JSON.parse(sourceTokenJson) as {
                  genesis?: {
                    data?: {
                      coinData?: ReadonlyArray<readonly [string, string]> | null;
                    };
                  };
                };
                const cd = parsed?.genesis?.data?.coinData;
                if (!Array.isArray(cd) || cd.length === 0) return null;
                const coins = cd
                  .filter(
                    (e): e is readonly [string, string] =>
                      Array.isArray(e) && e.length === 2 &&
                      typeof e[0] === 'string' && typeof e[1] === 'string',
                  )
                  .map(([cid, amt]) => ({ coinId: cid, amount: BigInt(amt) }))
                  .filter((c) => c.amount > 0n);
                return coins.length > 0 ? coins : null;
              } catch {
                return [{ coinId: token.coinId, amount: BigInt(token.amount || '0') }];
              }
            })(),
          };
          const tokenClass = classifyTokenLike(sourceTokenLike);

          out.push({
            sourceTokenId: token.id,
            method: 'direct',
            requestIdHex,
            sourceTokenJson,
            transferTxJson,
            tokenClass,
          });

          // Conservative: archive the source immediately (proof is
          // attached, the recipient can finalize on their own).
          // Instant: leave the source as `transferring` — T.5.B's
          // worker handles the source-side bookkeeping after proof.
          if (txfFinalization === 'conservative') {
            await this.removeToken(token.id, transferId);
          }
        }
        return out;
      },
      // markSourcePending — instant variant: spendPlanner already
      // marked sources `transferring`. Production wiring will pivot
      // these to the canonical 'pending' enum in T.5.B.
      markSourcePending: async () => {
        // No-op — selectSources marks sources `transferring`.
      },
      // outbox — T.7.A leaves the writer unwired in the dispatcher.
      // The legacy synthetic-entry chain (saveToOutbox /
      // removeFromOutbox) is preserved by way of the spend planner /
      // remove-token paths above; the per-entry-key OutboxWriter
      // integration ships in a follow-up wave. Tests inject a recorder.
      outbox: undefined,
      // onTriggerFinalization — instant-TXF only; conservative skips.
      // Production wiring would register the per-token outbox entry
      // with the worker registry; T.5.B's worker picks up orphan
      // delivered-instant entries on boot regardless.
      onTriggerFinalization: undefined,
    };

    return sendTxfUxf(originalRequest, recipient, deps, txfFinalization);
  }

  /**
   * Create SDK TransferCommitment for a token transfer
   */
  private async createSdkCommitment(
    token: Token,
    recipientAddress: IAddress,
    signingService: SigningService,
    onChainMessage?: Uint8Array | null
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
      null, // recipientDataHash
      onChainMessage ?? null, // on-chain message bytes
      signingService
    );

    return commitment;
  }

  /**
   * Create SigningService from identity private key.
   *
   * Steelman³² critical: previously decoded the privateKey hex via
   * `match(/.{1,2}/g)` + parseInt — silent-truncation on odd-length
   * inputs and silent NaN-coercion on non-hex chars. Used for the
   * wallet's signing key on every transaction. Now uses the strict
   * fromHex defined at line 554 of this file.
   */
  private async createSigningService(): Promise<SigningService> {
    const privateKeyHex = this.deps!.identity.privateKey;
    const privateKeyBytes = fromHex(privateKeyHex);
    return SigningService.createFromSecret(privateKeyBytes);
  }

  /**
   * Get the wallet's signing public key (used for token ownership predicates).
   * This is the key that token state predicates are checked against.
   */
  async getSigningPublicKey(): Promise<Uint8Array> {
    this.ensureInitialized();
    const signer = await this.createSigningService();
    return signer.publicKey;
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

    // Convert hex pubkey to bytes — Steelman³² critical: use strict
    // fromHex. Pubkey is attacker-controlled (peer input).
    const pubkeyBytes = fromHex(pubkeyHex);

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
      logger.debug('Payments', 'Creating DirectAddress from 33-byte compressed pubkey');
      return this.createDirectAddressFromPubkey(recipient);
    }

    // For nametag-based recipients, use PeerInfo (pre-resolved or resolve now)
    const info = peerInfo ?? await this.deps?.transport.resolve?.(recipient) ?? null;
    if (!info) {
      throw new SphereError(
        `Recipient "${recipient}" not found. ` +
        `Use @nametag, a valid PROXY:/DIRECT: address, or a 33-byte hex pubkey.`,
        'INVALID_RECIPIENT',
      );
    }

    // Determine nametag for PROXY address derivation
    const nametag = recipient.startsWith('@') ? recipient.slice(1)
      : info.nametag || recipient;

    // Force PROXY mode
    if (addressMode === 'proxy') {
      logger.debug('Payments', `Using PROXY address for "${nametag}" (forced)`);
      return ProxyAddress.fromNameTag(nametag);
    }

    // Force DIRECT mode
    if (addressMode === 'direct') {
      if (!info.directAddress) {
        throw new SphereError(`"${nametag}" has no DirectAddress stored. It may be a legacy registration.`, 'INVALID_RECIPIENT');
      }
      logger.debug('Payments', `Using DirectAddress for "${nametag}" (forced): ${info.directAddress.slice(0, 30)}...`);
      return AddressFactory.createAddress(info.directAddress);
    }

    // AUTO mode: prefer directAddress, fallback to PROXY for legacy
    if (info.directAddress) {
      logger.debug('Payments', `Using DirectAddress for "${nametag}": ${info.directAddress.slice(0, 30)}...`);
      return AddressFactory.createAddress(info.directAddress);
    }

    logger.debug('Payments', `Using PROXY address for legacy nametag "${nametag}"`);
    return ProxyAddress.fromNameTag(nametag);
  }

  /**
   * Handle NOSTR-FIRST commitment-only transfer (recipient side)
   * This is called when receiving a transfer with only commitmentData and no proof yet.
   * Delegates to saveCommitmentOnlyToken() helper, then emits event + records history.
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
        logger.warn('Payments', 'Invalid NOSTR-FIRST transfer format');
        return;
      }

      const token = await this.saveCommitmentOnlyToken(
        sourceTokenInput,
        commitmentInput,
        transfer.senderTransportPubkey,
      );
      if (!token) return;

      // Resolve sender info for both event and history
      const senderInfo = await this.resolveSenderInfo(transfer.senderTransportPubkey);

      // Emit event for incoming transfer (even though unconfirmed)
      this.deps!.emitEvent('transfer:incoming', {
        id: transfer.id,
        senderPubkey: transfer.senderTransportPubkey,
        senderNametag: senderInfo.senderNametag,
        tokens: [token],
        memo: payload.memo as string | undefined,
        receivedAt: transfer.timestamp,
      });

      // Record in history immediately
      const nostrTokenId = extractTokenIdFromSdkData(token.sdkData);
      await this.addToHistory({
        type: 'RECEIVED',
        amount: token.amount,
        coinId: token.coinId,
        symbol: token.symbol,
        timestamp: Date.now(),
        senderPubkey: transfer.senderTransportPubkey,
        ...senderInfo,
        memo: payload.memo as string | undefined,
        tokenId: nostrTokenId || token.id,
      });
    } catch (error) {
      logger.error('Payments', 'Failed to process NOSTR-FIRST transfer:', error);
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
      let proxyNametag = this.getNametag();

      // Recovery: if nametag is missing in memory (e.g., wiped by sync or race
      // condition during address switch), try reloading from storage
      if (!proxyNametag?.token) {
        logger.debug('Payments', 'Unicity ID missing in memory, attempting reload from storage...');
        await this.reloadNametagsFromStorage();
        proxyNametag = this.getNametag();
      }

      if (!proxyNametag?.token) {
        throw new SphereError('Cannot finalize PROXY transfer - no Unicity ID token', 'VALIDATION_ERROR');
      }
      const nametagToken = await SdkToken.fromJSON(proxyNametag.token);
      const proxy = await ProxyAddress.fromTokenId(nametagToken.id);
      if (proxy.address !== recipientAddress.address) {
        throw new SphereError(
          `PROXY address mismatch: nametag resolves to ${proxy.address} ` +
          `but transfer targets ${recipientAddress.address}`,
          'VALIDATION_ERROR',
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
  ): Promise<void> {
    try {
      const token = this.tokens.get(tokenId);
      if (!token) {
        logger.debug('Payments', `Token ${tokenId} not found for finalization`);
        return;
      }

      // Get proof from aggregator
      const commitment = await TransferCommitment.fromJSON(commitmentInput);
      if (!this.deps!.oracle.waitForProofSdk) {
        logger.debug('Payments', 'Cannot finalize - no waitForProofSdk');
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
        logger.debug('Payments', 'Cannot finalize - missing state transition client or trust base');
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

      // Spend Queue: cache newly confirmed token and wake queued entries
      const nostrAmount = this.extractCoinAmountForCache(finalizedSdkToken, finalizedToken.coinId);
      if (nostrAmount > 0n) {
        this.parsedTokenCache.set(tokenId, { token: finalizedToken, sdkToken: finalizedSdkToken, amount: nostrAmount });
        this.spendQueue.notifyChange(finalizedToken.coinId);
      }

      logger.debug('Payments', `NOSTR-FIRST: Token ${tokenId.slice(0, 8)}... finalized and confirmed`);

      // Emit confirmation event
      this.deps!.emitEvent('transfer:confirmed', {
        id: crypto.randomUUID(),
        status: 'completed',
        tokens: [finalizedToken],
        tokenTransfers: [],
      });

      // History entry was already created in handleCommitmentOnlyTransfer() — no duplicate here
    } catch (error) {
      logger.error('Payments', 'Failed to finalize received token:', error);
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
    // Ensure load() has completed so dedup checks see all persisted tokens.
    if (!this.loaded && this.loadedPromise) {
      await this.loadedPromise;
    }

    // T.3.E — UXF v1.0 routing gate. Bundles with an explicit `kind`
    // discriminator (`'uxf-car'` or `'uxf-cid'`) are first-class UXF
    // arrivals; route them to the ingest worker pool when the flag is
    // on AND a pool has been installed. Legacy shapes (no `kind` field)
    // fall through to the legacy adapter path below regardless of the
    // flag — they never enter the pool.
    if (this.features.recipientUxf && this.ingestPool && isUxfV1Payload(transfer.payload)) {
      try {
        await this.ingestPool.enqueue(transfer.payload, transfer.senderTransportPubkey);
      } catch (err) {
        // INGEST_QUEUE_FULL / INGEST_QUEUE_FULL_PER_TOKEN — already
        // emitted via the typed event bus inside the pool. We log here
        // for traceability; the sender's outbox will time out.
        logger.warn('Payments', 'handleIncomingTransfer: ingest pool rejected bundle', err);
      }
      return;
    }

    // T.7.B — legacy-shape adapter routing. When the flag is on AND a
    // runner has been installed, route the legacy event through the
    // adapter BEFORE the legacy storage path runs. The two paths are
    // additive: the adapter produces dispositions for the OrbitDB
    // profile (T.3.C disposition writer); the legacy path below
    // continues to populate the legacy token storage. Failures inside
    // the runner are logged but do NOT abort the legacy path — both
    // pipelines must converge to the same outcome per §10.2.
    if (
      this.features.recipientLegacyAdapter &&
      this.legacyShapeAdapterRunner !== null &&
      isLegacyTokenTransferPayload(transfer.payload)
    ) {
      try {
        await this.legacyShapeAdapterRunner.processLegacy(
          transfer.payload,
          transfer.senderTransportPubkey,
        );
      } catch (err) {
        // The runner's contract specifies "MUST NOT throw under normal
        // operation" — a throw indicates a wiring bug. We log and
        // continue to the legacy path so the receiver still records
        // the token in its legacy storage.
        logger.warn(
          'Payments',
          'handleIncomingTransfer: legacy-shape adapter runner threw',
          err,
        );
      }
      // Note: deliberately falling through to the legacy storage path
      // below. The adapter writes to the OrbitDB profile; the legacy
      // path writes to the per-address token storage. Both must run
      // for §10.2 single-pipeline convergence to hold across the
      // transition window.
    }

    try {
      // Check payload format - Sphere wallet sends { sourceToken, transferTx }
      // SDK format is { token, proof }
      // COMBINED_TRANSFER V6 format is { type: 'COMBINED_TRANSFER', version: '6.0', ... }
      // INSTANT_SPLIT format is { type: 'INSTANT_SPLIT', version, ... }
      const payload = transfer.payload as unknown as Record<string, unknown>;
      logger.debug('Payments', 'handleIncomingTransfer: keys=', Object.keys(payload).join(','));

      // Check for COMBINED_TRANSFER V6 bundle (single message containing all tokens)
      let combinedBundle: CombinedTransferBundleV6 | null = null;
      if (isCombinedTransferBundleV6(payload)) {
        combinedBundle = payload as CombinedTransferBundleV6;
      } else if (payload.token) {
        try {
          const inner = typeof payload.token === 'string' ? JSON.parse(payload.token as string) : payload.token;
          if (isCombinedTransferBundleV6(inner)) {
            combinedBundle = inner as CombinedTransferBundleV6;
          }
        } catch {
          // Not a JSON string or not a V6 bundle - fall through
        }
      }

      if (combinedBundle) {
        logger.debug('Payments', 'Processing COMBINED_TRANSFER V6 bundle...');
        try {
          await this.processCombinedTransferBundle(combinedBundle, transfer.senderTransportPubkey);
          logger.debug('Payments', 'COMBINED_TRANSFER V6 processed successfully');
        } catch (err) {
          logger.error('Payments', 'COMBINED_TRANSFER V6 processing error:', err);
        }
        return;
      }

      // Check for INSTANT_SPLIT bundle (V4/V5 standalone — backward compat)
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
        logger.debug('Payments', 'Processing INSTANT_SPLIT bundle...');
        try {
          const result = await this.processInstantSplitBundle(
            instantBundle,
            transfer.senderTransportPubkey,
            payload.memo as string | undefined,
          );
          if (result.success) {
            logger.debug('Payments', 'INSTANT_SPLIT processed successfully');
          } else {
            logger.warn('Payments', 'INSTANT_SPLIT processing failed:', result.error);
          }
        } catch (err) {
          logger.error('Payments', 'INSTANT_SPLIT processing error:', err);
        }
        return;
      }

      // Check for NOSTR-FIRST commitment-only transfer (whole-token instant send)
      if (payload.sourceToken && payload.commitmentData && !payload.transferTx) {
        logger.debug('Payments', 'NOSTR-FIRST commitment-only transfer detected');
        await this.handleCommitmentOnlyTransfer(transfer, payload);
        return;
      }

      let tokenData: unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let finalizedSdkToken: SdkToken<any> | null = null;

      if (payload.sourceToken && payload.transferTx) {
        // Sphere wallet format - needs finalization for PROXY addresses
        logger.debug('Payments', 'Processing Sphere wallet format transfer...');

        const sourceTokenInput = typeof payload.sourceToken === 'string'
          ? JSON.parse(payload.sourceToken as string)
          : payload.sourceToken;
        const transferTxInput = typeof payload.transferTx === 'string'
          ? JSON.parse(payload.transferTx as string)
          : payload.transferTx;

        if (!sourceTokenInput || !transferTxInput) {
          logger.warn('Payments', 'Invalid Sphere wallet transfer format');
          return;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let sourceToken: SdkToken<any>;
        let transferTx: TransferTransaction;

        try {
          sourceToken = await SdkToken.fromJSON(sourceTokenInput);
        } catch (err) {
          logger.error('Payments', 'Failed to parse sourceToken:', err);
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
              logger.error('Payments', 'Cannot process commitment - no state transition client');
              return;
            }

            const response = await stClient.submitTransferCommitment(commitment);
            if (response.status !== 'SUCCESS' && response.status !== 'REQUEST_ID_EXISTS') {
              logger.error('Payments', 'Transfer commitment submission failed:', response.status);
              return;
            }

            if (!this.deps!.oracle.waitForProofSdk) {
              logger.error('Payments', 'Cannot wait for proof - missing oracle method');
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
                throw new SphereError('Cannot submit commitment - missing oracle methods', 'AGGREGATOR_ERROR');
              }
              await stClient.submitTransferCommitment(commitment);
              const inclusionProof = await this.deps!.oracle.waitForProofSdk(commitment);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              transferTx = commitment.toTransaction(inclusionProof as any);
            }
          }
        } catch (err) {
          logger.error('Payments', 'Failed to parse transferTx:', err);
          return;
        }

        // Finalize using shared helper (handles PROXY address validation)
        try {
          const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const trustBase = (this.deps!.oracle as any).getTrustBase?.();
          if (!stClient || !trustBase) {
            logger.error('Payments', 'Cannot finalize - missing state transition client or trust base. Token rejected.');
            return;
          }
          finalizedSdkToken = await this.finalizeTransferToken(sourceToken, transferTx, stClient, trustBase);
          tokenData = finalizedSdkToken.toJSON();
          const addressScheme = transferTx.data.recipient.scheme;
          logger.debug('Payments', `${addressScheme === AddressScheme.PROXY ? 'PROXY' : 'DIRECT'} finalization successful`);
        } catch (finalizeError) {
          logger.error('Payments', 'Finalization FAILED - token rejected:', finalizeError);
          return;
        }
      } else if (payload.token) {
        // SDK format
        tokenData = payload.token;
      } else {
        logger.warn('Payments', 'Unknown transfer payload format');
        return;
      }

      // Validate token
      const validation = await this.deps!.oracle.validateToken(tokenData);
      if (!validation.valid) {
        logger.warn('Payments', 'Received invalid token');
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
      const added = await this.addToken(token);
      const senderInfo = await this.resolveSenderInfo(transfer.senderTransportPubkey);

      if (added) {
        const incomingTokenId = extractTokenIdFromSdkData(token.sdkData);
        await this.addToHistory({
          type: 'RECEIVED',
          amount: token.amount,
          coinId: token.coinId,
          symbol: token.symbol,
          timestamp: Date.now(),
          senderPubkey: transfer.senderTransportPubkey,
          ...senderInfo,
          memo: payload.memo as string | undefined,
          tokenId: incomingTokenId || token.id,
        });

        const incomingTransfer: IncomingTransfer = {
          id: transfer.id,
          senderPubkey: transfer.senderTransportPubkey,
          senderNametag: senderInfo.senderNametag,
          tokens: [token],
          memo: payload.memo as string | undefined,
          receivedAt: transfer.timestamp,
        };

        this.deps!.emitEvent('transfer:incoming', incomingTransfer);
        logger.debug('Payments', `Incoming transfer processed: ${token.id}, ${token.amount} ${token.symbol}`);
      } else {
        logger.debug('Payments', `Duplicate transfer ignored: ${token.id}, ${token.amount} ${token.symbol}`);
      }
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

  /**
   * Save-chain single-flight (steelman fix #3 — concurrent-save race).
   *
   * Many call sites invoke save() (incoming-transfer handlers, 10-s resolver
   * tick, manual sync, addToken, removeToken, etc.). Without serialization,
   * concurrent saves read different snapshots of this.tokens, pin different
   * CIDs (each with a random IV → different content-address), and race on
   * OrbitDB LWW. If save A reads `{T1}` and save B reads `{T1,T2}`, but
   * A's storage.set lands LAST, the OpLog points at A's CID `{T1}`. T2 is
   * lost forever because V5 tokens are not in TXF storage.
   *
   * The single-flight pattern serializes saves through a promise chain:
   * each save() awaits the previous save's completion before reading
   * this.tokens. This eliminates the torn-snapshot race.
   *
   * Caveat: saves are still independent units — a failure in save N does
   * not abort save N+1 (we catch to clear the chain state). The chain
   * guarantees ORDERING, not atomicity.
   */
  private _saveChain: Promise<void> = Promise.resolve();

  /**
   * W11 originated-tag helper (SPEC §10.2.3). Writes through
   * `storage.setEntry` when the provider supports it so the
   * OpLog envelope carries an explicit `originated` tag matching
   * the semantic class of the write. Providers without
   * envelope-storage (plain IndexedDB / file KV) fall through to
   * the plain `set()` — semantics are identical, only the
   * peer-replicated classification differs.
   *
   * Classification (see profile/aggregator-pointer/originated-tag.ts):
   *   - `token_send`      — user-initiated outbound transfer
   *   - `token_receive`   — user-initiated inbound pending transfer
   *   - `cache_index`     — dedup / state-empty / operational state
   *
   * Callers MUST choose the classification at the call site — the
   * helper does NOT infer. Mis-classification is caught by
   * `assertOriginTagLocal` inside the storage layer and surfaced as
   * SECURITY_ORIGIN_MISMATCH.
   */
  private async setStorageEntry(
    key: string,
    value: string,
    entryType: 'token_send' | 'token_receive' | 'cache_index',
  ): Promise<void> {
    const storage = this.deps!.storage;
    const setEntryFn = (storage as { setEntry?: (k: string, v: string, t: string) => Promise<void> })
      .setEntry;
    if (typeof setEntryFn === 'function') {
      await setEntryFn.call(storage, key, value, entryType);
      return;
    }
    // Fallback: provider has no envelope-storage layer (plain IndexedDB
    // / file KV). Log once per provider-class so a silent loss of W11
    // stamping during a migration is visible in ops. Subsequent calls
    // from the same class are silent to avoid log spam.
    const providerClass = storage.constructor?.name ?? 'UnknownStorage';
    if (!PaymentsModule._w11FallbackLogged.has(providerClass)) {
      PaymentsModule._w11FallbackLogged.add(providerClass);
      logger.debug(
        'Payments',
        `[W11] storage.setEntry not available on ${providerClass}; originated tags will not be stamped ` +
          `(this is expected for plain IndexedDB / file storage, unexpected when ProfileStorageProvider is in the chain).`,
      );
    }
    await storage.set(key, value);
  }

  /** Per-class dedup set for the W11 fallback log (see setStorageEntry). */
  private static _w11FallbackLogged: Set<string> = new Set();

  private async save(): Promise<void> {
    // Chain onto the previous save. Failure in prior save is isolated via
    // .catch() so it does not block subsequent saves — each save is
    // independently attempted and reported via logger.
    const mySave = this._saveChain
      .catch(() => {
        // Previous save failed; don't let the error propagate to block us.
        // The previous save's caller already received the rejection.
      })
      .then(() => this._doSave());
    this._saveChain = mySave;
    return mySave;
  }

  private async _doSave(): Promise<void> {
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

    // Always save pending V5 tokens to KV storage (separate from TXF providers).
    // V5 pending tokens can't be serialized to TXF, so they use KV regardless
    // of whether TXF providers exist.
    await this.savePendingV5Tokens();
  }

  /**
   * Memoized plaintext + CID ref for the last outbox pin. See the V5-tokens
   * equivalent (`_lastPinnedV5Json` / `_lastPinnedV5Ref`) for rationale: AES-GCM
   * uses random IVs, so re-pinning identical plaintext produces a different
   * CID; we'd rather write the cached ref than thrash the IPFS gateway.
   */
  private _lastPinnedOutboxJson: string | null = null;
  private _lastPinnedOutboxRef: CidRef | null = null;

  /**
   * Single-flight chain for outbox mutations. `saveToOutbox` and
   * `removeFromOutbox` do a load → mutate → write sequence, which races
   * without serialization: two concurrent `send()` calls (or a `send()`
   * racing a `finalize()`) can both read the same snapshot and the second
   * writer silently clobbers the first. Chaining ops through a promise
   * guarantees ordering. Mirrors `_saveChain` for pendingV5 tokens.
   *
   * Caveat: guarantees ORDERING, not atomicity — a failing op doesn't roll
   * back but also doesn't block the next op (prior failure is isolated
   * via .catch() so it doesn't propagate).
   */
  private _outboxChain: Promise<void> = Promise.resolve();

  private enqueueOutboxOp<T>(op: () => Promise<T>): Promise<T> {
    const chained = this._outboxChain
      .catch(() => {
        /* isolate prior failure — the caller of the failing op already
           received the rejection; subsequent ops should not be blocked. */
      })
      .then(op);
    // Keep the chain alive across failures so ordering holds for the next op.
    this._outboxChain = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  private async saveToOutbox(transfer: TransferResult, recipient: string): Promise<void> {
    return this.enqueueOutboxOp(async () => {
      const outbox = await this.loadOutbox();
      outbox.push({ transfer, recipient, createdAt: Date.now() });
      await this.writeOutbox(outbox);
    });
  }

  private async removeFromOutbox(transferId: string): Promise<void> {
    return this.enqueueOutboxOp(async () => {
      const outbox = await this.loadOutbox();
      const filtered = outbox.filter((e) => e.transfer.id !== transferId);
      await this.writeOutbox(filtered);
    });
  }

  /**
   * Write the outbox list — via CID reference when `cidRefStore` is injected,
   * inline JSON otherwise. PROFILE-CID-REFERENCES.md §8.2 (Pattern A).
   *
   * Outbox entries wrap `TransferResult`, which contains `Token[]` with fat
   * `sdkData` (5–20 KB/token). Even modest wallets routinely push the inline
   * blob past 100 KB — hence the migration to an IPFS-pinned envelope that
   * shows up in the OpLog as a ~150-byte reference.
   */
  private async writeOutbox(
    list: Array<{ transfer: TransferResult; recipient: string; createdAt: number }>,
  ): Promise<void> {
    const cidRefStore = this.deps!.cidRefStore;

    if (list.length === 0) {
      // Empty outbox: write empty string to match legacy behaviour and clear
      // the memo so the next non-empty save re-pins (can't reuse a stale ref).
      // Classification: `cache_index` — the user action (token_send) has
      // already completed; this write is operational cleanup.
      await this.setStorageEntry(STORAGE_KEYS_ADDRESS.OUTBOX, '', 'cache_index');
      this._lastPinnedOutboxJson = null;
      this._lastPinnedOutboxRef = null;
      return;
    }

    if (cidRefStore) {
      const json = JSON.stringify(list);

      // Skip pin if plaintext is byte-identical to the last pin. Common on
      // concurrent writers that observe the same snapshot.
      if (this._lastPinnedOutboxRef && this._lastPinnedOutboxJson === json) {
        const refStr = CidRefStore.stringifyRef(this._lastPinnedOutboxRef);
        await this.setStorageEntry(STORAGE_KEYS_ADDRESS.OUTBOX, refStr, 'token_send');
        return;
      }

      const ref = await cidRefStore.pinJson(list);
      const refStr = CidRefStore.stringifyRef(ref);
      await this.setStorageEntry(STORAGE_KEYS_ADDRESS.OUTBOX, refStr, 'token_send');
      // Update memo AFTER a successful storage.set — see pendingV5 equivalent.
      this._lastPinnedOutboxJson = json;
      this._lastPinnedOutboxRef = ref;
      return;
    }

    // Legacy path: inline JSON (deprecated — see PROFILE-CID-REFERENCES.md).
    await this.setStorageEntry(STORAGE_KEYS_ADDRESS.OUTBOX, JSON.stringify(list), 'token_send');
  }

  /**
   * Load the outbox — dual-read per PROFILE-CID-REFERENCES.md §6. Detects
   * CID-ref envelope via `tryParseRef`; falls back to legacy inline JSON.
   *
   * Error handling (matches `loadPendingV5Tokens`):
   *   - CID ref present but no cidRefStore injected → throws a typed
   *     `ProfileError('CID_REF_UNREADABLE')`. The caller surfaces a
   *     configuration error rather than silently dropping outgoing transfers
   *     (which would leak user funds in the pending state).
   *   - IPFS fetch / verify / decrypt errors propagate with their typed codes.
   *   - Legacy-JSON parse failures are caught narrowly (SyntaxError only).
   */
  private async loadOutbox(): Promise<Array<{ transfer: TransferResult; recipient: string; createdAt: number }>> {
    const data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.OUTBOX);
    if (!data) return [];

    const ref = CidRefStore.tryParseRef(data);
    if (ref) {
      if (!this.deps!.cidRefStore) {
        const { ProfileError } = await import('../../profile/errors.js');
        throw new ProfileError(
          'CID_REF_UNREADABLE',
          `PaymentsModule.loadOutbox: KV at ${STORAGE_KEYS_ADDRESS.OUTBOX} ` +
            `contains a CID ref (cid=${ref.cid}) but no cidRefStore was injected. ` +
            `Outbox cannot be restored without IPFS access. ` +
            `Check PaymentsModule init — is cidRefStore provided?`,
        );
      }
      return await this.deps!.cidRefStore.fetchJson<
        Array<{ transfer: TransferResult; recipient: string; createdAt: number }>
      >(ref);
    }

    // Legacy inline JSON. Narrow catch: only swallow SyntaxError from a
    // corrupted legacy blob; unknown errors propagate.
    try {
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) {
        // Matches pendingV5 defensive path — log so corruption is visible
        // rather than silently returning [] (which would mask data loss and
        // allow a subsequent saveToOutbox to overwrite the forensic evidence).
        logger.error(
          'Payments',
          `[OUTBOX] Decoded data is not an array (got ${typeof parsed}); treating as empty.`,
        );
        return [];
      }
      return parsed;
    } catch (err) {
      if (err instanceof SyntaxError) {
        logger.error('Payments', '[OUTBOX] Legacy JSON parse failed (corrupted inline data):', err);
        return [];
      }
      throw err;
    }
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
        logger.debug('Payments', 'Cannot submit commitment - no state transition client');
        return;
      }

      const response = await stClient.submitTransferCommitment(commitment);
      if (response.status !== 'SUCCESS' && response.status !== 'REQUEST_ID_EXISTS') {
        logger.debug('Payments', `Transfer commitment submission failed: ${response.status}`);
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
      logger.debug('Payments', 'submitAndPollForProof error:', error);
    }
  }

  /**
   * Add a proof polling job to the queue
   */
  private addProofPollingJob(job: ProofPollingJob): void {
    this.proofPollingJobs.set(job.tokenId, job);
    logger.debug('Payments', `Added proof polling job for token ${job.tokenId.slice(0, 8)}...`);
    this.startProofPolling();
  }

  /**
   * Start the proof polling interval if not already running
   */
  private startProofPolling(): void {
    if (this.proofPollingInterval) return;
    if (this.proofPollingJobs.size === 0) return;

    logger.debug('Payments', 'Starting proof polling...');
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
      logger.debug('Payments', 'Stopped proof polling');
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
          logger.debug('Payments', `Proof polling timeout for token ${tokenId.slice(0, 8)}...`);
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
        } catch (_err) {
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
          logger.debug('Payments', `Proof received for token ${tokenId.slice(0, 8)}..., status: spent`);
        }

        // Call callback if provided
        job.onProofReceived?.(tokenId);
        completedJobs.push(tokenId);
      } catch (error) {
        // Most errors mean proof is not ready yet, continue polling
        logger.debug('Payments', `Proof polling attempt ${job.attemptCount} for ${tokenId.slice(0, 8)}...: ${error}`);
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
      throw new SphereError('PaymentsModule not initialized', 'NOT_INITIALIZED');
    }
  }
}

// =============================================================================
// Phase 9.6.D — Default FinalizationWorkerSender factory
// =============================================================================

/**
 * Build the default auto-installed {@link FinalizationWorkerSender} for
 * {@link PaymentsModule.initialize}. Uses lightweight in-memory adapters
 * for the pool/manifest/tombstone/queue 4-step write order (no OrbitDB
 * required). Sufficient for §6.1 cycle completion and `transfer:confirmed`
 * emission.
 *
 * @internal — exported only for unit-test access.
 */
export function buildDefaultFinalizationWorkerSender(opts: {
  readonly addressId: string;
  readonly oracle: import('../../oracle').OracleProvider;
  readonly senderOutboxMap: Map<string, UxfTransferOutboxEntry>;
  readonly senderRequestContextMap: Map<string, RequestContext>;
  readonly emit: <T extends import('../../types').SphereEventType>(
    type: T,
    data: import('../../types').SphereEventMap[T],
  ) => void;
}): FinalizationWorkerSender {
  const { addressId, oracle, senderOutboxMap, senderRequestContextMap, emit } = opts;

  // In-memory outbox writer — thin wrapper over the module's _senderOutboxMap.
  const outbox: FinalizationOutboxWriter = {
    async readOne(id: string): Promise<UxfTransferOutboxEntry | null> {
      return senderOutboxMap.get(id) ?? null;
    },
    async update(
      id: string,
      mutator: (prev: UxfTransferOutboxEntry) => UxfTransferOutboxEntry,
    ): Promise<UxfTransferOutboxEntry> {
      const existing = senderOutboxMap.get(id);
      if (existing === null || existing === undefined) {
        throw new SphereError(
          `FinalizationOutboxWriter.update: no entry at id "${id}"`,
          'VALIDATION_ERROR',
        );
      }
      const next = mutator(existing);
      // Bump Lamport on every write so the worker's W26 state is consistent.
      const bumped: UxfTransferOutboxEntry = { ...next, lamport: (existing.lamport ?? 0) + 1 };
      senderOutboxMap.set(id, bumped);
      return bumped;
    },
  };

  // In-memory resolver — returns per-requestId context stored at commit time.
  const resolver: RequestContextResolver = {
    async resolve(input) {
      return senderRequestContextMap.get(input.requestId) ?? null;
    },
  };

  // In-memory pool adapter — no-op writes; sufficient for transfer:confirmed.
  const proofAttached = new Set<string>();
  const pool = {
    async isProofAttached(tokenId: string, reqId: string): Promise<boolean> {
      return proofAttached.has(`${tokenId}:${reqId}`);
    },
    async attachProof(tokenId: string, reqId: string): Promise<void> {
      proofAttached.add(`${tokenId}:${reqId}`);
    },
  };

  // In-memory pool read adapter.
  const poolProofs = new Map<string, import('./transfer/finalization-worker-base').AnchoredProofDescriptor>();
  const poolRead = {
    async getAttachedProof(
      tokenId: string,
      reqId: string,
    ): Promise<import('./transfer/finalization-worker-base').AnchoredProofDescriptor | null> {
      return poolProofs.get(`${tokenId}:${reqId}`) ?? null;
    },
  };

  // In-memory manifest storage — needed by ManifestCas.
  const manifestEntries = new Map<string, import('../../profile/token-manifest').TokenManifestEntry>();
  const manifestStorage: MinimalManifestStorage = {
    async readEntry(addr: string, tokenId: string) {
      return manifestEntries.get(`${addr}:${tokenId}`);
    },
    async writeEntry(addr: string, tokenId: string, entry: import('../../profile/token-manifest').TokenManifestEntry) {
      manifestEntries.set(`${addr}:${tokenId}`, entry);
    },
  };
  const manifestCas = new ManifestCas(manifestStorage);

  // In-memory tombstone adapter.
  const tombstoneSet = new Set<string>();
  const tombstones = {
    async hasTombstone(tokenId: string, cid: ContentHash): Promise<boolean> {
      return tombstoneSet.has(`${tokenId}:${cid}`);
    },
    async insertTombstone(tokenId: string, cid: ContentHash): Promise<void> {
      tombstoneSet.add(`${tokenId}:${cid}`);
    },
  };

  // In-memory finalization queue adapter.
  const queueEntries = new Set<string>();
  const queue = {
    async hasEntry(addr: string, reqId: string): Promise<boolean> {
      return queueEntries.has(`${addr}:${reqId}`);
    },
    async removeEntry(addr: string, reqId: string): Promise<void> {
      queueEntries.delete(`${addr}:${reqId}`);
    },
  };

  // Aggregator adapter — submit returns REQUEST_ID_EXISTS (already submitted
  // by commitSources); poll delegates to oracle.getProof(requestId).
  const aggregatorClient: FinalizationAggregatorClient = {
    async submit(_input): Promise<SubmitOutcome> {
      // The commitment was already submitted in commitSources. Return
      // REQUEST_ID_EXISTS so the cycle proceeds straight to polling.
      return { kind: 'REQUEST_ID_EXISTS' };
    },
    async poll(input): Promise<PollOutcome> {
      try {
        const proof = await oracle.getProof(input.requestId);
        if (proof === null || proof === undefined) {
          // Proof not yet available — retry next poll iteration.
          return { kind: 'TRANSIENT' };
        }
        // Build AnchoredProofDescriptor from the oracle's InclusionProof.
        // transactionHash: use the requestId itself (the aggregator key).
        // authenticator: use requestId as a proxy (§6.3 same-value check).
        // roundNumber: from the oracle proof.
        const descriptor: import('./transfer/finalization-worker-base').AnchoredProofDescriptor = {
          transactionHash: proof.requestId,
          authenticator: proof.requestId,
          roundNumber: proof.roundNumber,
          proof: proof.proof,
        };
        // Store in poolRead so §6.3 most-recent-proof check can compare.
        poolProofs.set(`${input.tokenId}:${input.requestId}`, descriptor);
        // newCid: use a stable placeholder derived from requestId.
        // The in-memory manifest/tombstone/queue adapters don't care about the
        // actual CID content; they just key on (addr, tokenId).
        const newCid = contentHash(
          (input.requestId.replace(/[^0-9a-f]/gi, '').padStart(64, '0')).slice(0, 64),
        );
        return { kind: 'OK', proof: descriptor, newCid };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'TRANSIENT', error: `oracle.getProof threw: ${message}` };
      }
    },
  };

  // Per-token semaphore factory — each tokenId gets its own semaphore.
  const perTokenSemaphores = new Map<string, CountingSemaphore>();
  const getPerTokenSemaphore = (tokenId: string): CountingSemaphore => {
    let sem = perTokenSemaphores.get(tokenId);
    if (sem === undefined) {
      sem = new CountingSemaphore(4); // MAX_CONCURRENT_POLLS_PER_TOKEN
      perTokenSemaphores.set(tokenId, sem);
    }
    return sem;
  };

  // Per-token mutex — shared for all requestIds within the same address.
  const perTokenMutex = new PerTokenMutex();

  return new FinalizationWorkerSender({
    addressId,
    outbox,
    aggregator: aggregatorClient,
    resolver,
    pool,
    poolRead,
    manifestCas,
    tombstones,
    queue,
    getPerTokenSemaphore,
    perTokenMutex,
    emit,
    now: () => Date.now(),
    sleep: (ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      }),
  });
}

// =============================================================================
// Factory Function
// =============================================================================

export function createPaymentsModule(config?: PaymentsModuleConfig): PaymentsModule {
  return new PaymentsModule(config);
}
