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
import { sanitizeReasonString } from '../../core/error-sanitize';
import {
  narrowTransferMode,
  requireLegacyCoinSlot,
  type LegacyCoinTransferRequest,
} from './transfer/transfer-mode-shims';
import {
  sendConservativeUxf,
  type ConservativeCommitResult,
  type ConservativeSenderDeps,
  type ConservativeSourceSelection,
  type OutboxCreateInput,
} from './transfer/conservative-sender';
import {
  extractPendingChainFromSdkData,
  finalizeSourceTokenChain,
} from './transfer/conservative-source-finalize';
import {
  sendInstantUxf,
  type InstantCommitResult,
  type InstantSenderDeps,
  type InstantSourceSelection,
} from './transfer/instant-sender';
import type { PublishToIpfsCallback } from './transfer/delivery-resolver';
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
// Issue #166 P2 #4 — SENT-write reconciliation worker. Auto-installed in
// `initialize()` when `features.sentReconciliationWorker` is true
// (default-ON). Retries SENT-ledger writes that failed at the
// dispatcher's delivered-transition (per round-2 steelman fix in PR #97
// commit `fcf1d53`, which keeps OUTBOX entries live at `status='delivered'`
// when SENT write fails so an operator can complete the recovery).
import {
  SentReconciliationWorker,
  type SentReconciliationWorkerDeps,
} from './transfer/sent-reconciliation-worker';
// Issue #166 P2 #3 — Nostr persistence verification worker. Auto-installed
// in `initialize()` when `features.nostrPersistenceVerifier` is true
// (default-OFF — adds relay query traffic; opt-in until soak-tested).
// Periodically re-queries the relay for SENT entries' Nostr event ids to
// detect retention drops (events accepted at publish but later evicted).
import {
  NostrPersistenceVerifier,
  type NostrPersistenceVerifierDeps,
  type VerifyOutcome,
} from './transfer/nostr-persistence-verifier';
// Issue #174 — per-token spent-state rescan worker
// (UXF-TRANSFER-PROTOCOL §12.3.2). Auto-installed in `initialize()` when
// `features.spentStateRescan` is true (default-OFF). Proactively probes
// each `'confirmed'` token's current destination state hash against
// `oracle.isSpent` to detect off-record spends (typically a sibling
// device on the same keys). Companion to the reactive
// `'transfer:double-spend-detected'` surface (Item #14 Phase 1).
import {
  SpentStateRescanWorker,
  type SpentStateRescanWorkerDeps,
  type TransitionToAuditFn,
} from './transfer/spent-state-rescan-worker';
// OUTBOX-SEND-FOLLOWUPS item #4 — tombstone GC worker. Auto-installed in
// `initialize()` when `features.tombstoneGcWorker` is true. Periodically
// replaces expired tombstones (older than the configured retention
// window) with real db.del() calls to reclaim OrbitDB log bytes.
import {
  TombstoneGcWorker,
  type TombstoneGcWorkerDeps,
} from './transfer/tombstone-gc-worker';
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
// Task #151 — wired. The recipient worker is auto-instantiated in
// initialize() with lightweight in-memory adapters (see
// `buildDefaultFinalizationWorkerRecipient` at the bottom of this file).
// processToken enqueues PENDING entries on the instant-mode receive
// path; the worker drives §6.1 polling and a dispositionWriter that
// flips local Token status to 'confirmed' once the proof lands.
import {
  FinalizationWorkerRecipient,
  type FinalizationDispositionWriter,
  type RevaluateHooksProvider,
} from './transfer/finalization-worker-recipient';
import {
  FinalizationQueue,
  entryIdFor,
  type FinalizationQueueEntry,
} from './transfer/finalization-queue';
import {
  CascadeWalker,
  type CascadeManifestScanner,
  type CascadeOutboxScanner,
  type ClassifyTokenLookup,
} from './transfer/cascade-walker';
import { ManifestCas, type MinimalManifestStorage } from '../../profile/manifest-cas';
// Round 5 (FIX 1) — production-wired default importer/runner for the
// operator escape hatch. Uses lightweight in-memory adapters mirroring
// the auto-install pattern of `buildDefaultFinalizationWorkerSender`.
// Sphere bootstrap MAY override via the existing `install*` methods to
// inject OrbitDB-backed dispositionStorage + manifestStore (see
// {@link OrbitDbDispositionStorageAdapter}).
import { DispositionWriter } from '../../profile/disposition-writer';
import type { DispositionRecord } from '../../types/disposition';
import {
  InMemoryDispositionStorageAdapter,
} from '../../profile/disposition-storage-adapters';
import { ManifestStore } from '../../profile/manifest-store';
import { Lamport } from '../../profile/lamport';
import type { TokenManifestEntry } from '../../profile/token-manifest';
import type { CascadeManifestScanner as CascadeManifestScannerForRevalidate } from './transfer/cascade-walker';
import type { ProofVerifyStatus } from './transfer/proof-verifier';
import { contentHash, type ContentHash } from '../../uxf/types';
import { isLegacyTokenTransferPayload } from '../../types/uxf-transfer';
import type { UxfTransferOutboxEntry } from '../../types/uxf-outbox';
import type { UxfSentLedgerEntry } from '../../types/uxf-sent';
import type { OutboxWriter } from '../../profile/outbox-writer';
import type { SentLedgerWriter } from '../../profile/sent-ledger-writer';
import {
  sweepOrphanSpendingTokens,
  type OrphanSweepResult,
  type OrphanSpendingFinding,
} from './transfer/orphan-spending-sweeper';
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
import { PredicateEngineService } from '@unicitylabs/state-transition-sdk/lib/predicate/PredicateEngineService';
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
import { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId';
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
 * - SENT + transferId + coinId → one entry per coin per transfer (#149 multi-coin follow-up)
 * - SENT + transferId         → one entry per transfer (legacy / single-coin / coinId unknown)
 * - type + tokenId → one entry per token per direction
 * - fallback → UUID (no dedup possible)
 *
 * The coinId discriminator was added so multi-coin UXF sends produce one
 * SENT row per coin instead of clobbering all but the primary. Existing
 * single-coin entries in storage keep their legacy dedupKey; new entries
 * (post-fix) include the coinId suffix. The two formats are orthogonal
 * — they never collide for the same logical transfer because the
 * transferId is a fresh UUID per send.
 */
function computeHistoryDedupKey(
  type: string,
  tokenId?: string,
  transferId?: string,
  coinId?: string,
): string {
  if (type === 'SENT' && transferId) {
    return coinId
      ? `${type}_transfer_${transferId}_${coinId}`
      : `${type}_transfer_${transferId}`;
  }
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
// Sync Options & Result
// =============================================================================

export interface SyncOptions {
  /** When true (default), drain pending V5 finalizations before flushing to
   *  token-storage providers. Without draining, any token whose `sdkData`
   *  still carries `_pendingFinalization` round-trips through `tokenToTxf`
   *  as null and is silently dropped from the published CAR — a remote
   *  device joining via `recoverLatest()` then sees a partial inventory.
   *  Set false to preserve the legacy "publish whatever's confirmed"
   *  semantics. */
  drainPending?: boolean;
  /** Max time in ms to wait for pending V5 tokens to finalize before
   *  giving up (default: 30000). When `forceFlushOnDrainTimeout` is
   *  false (default) AND tokens remain pending after this budget, the
   *  flush is skipped and `drainTimedOut: true` is returned — the caller
   *  can retry once tokens have confirmed. */
  drainTimeoutMs?: number;
  /** Poll interval in ms while draining (default: 2000). */
  drainPollIntervalMs?: number;
  /** When true, publish whatever's confirmed even if pending tokens
   *  remain after `drainTimeoutMs`. Restores legacy behavior — pending
   *  tokens are silently dropped from the CAR. Default false. */
  forceFlushOnDrainTimeout?: boolean;
}

export interface SyncResult {
  /** Tokens added to local state from remote-merged data. */
  added: number;
  /** Tokens removed from local state via remote tombstones. */
  removed: number;
  /** Number of V5-pending tokens still unresolved when the flush ran.
   *  Non-zero only when `drainPending: false` was requested OR
   *  `forceFlushOnDrainTimeout: true` overrode a timed-out drain. */
  pendingAtFlush?: number;
  /** True iff `drainPending` was on, the drain timed out, and the flush
   *  was skipped (no partial CAR published). */
  drainTimedOut?: boolean;
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
   * Issue #166 P2 #4 — when `true` (default), auto-install and start a
   * {@link SentReconciliationWorker} in {@link PaymentsModule.initialize}
   * so SENT-ledger writes that failed at the dispatcher's
   * `delivered` / `delivered-instant` transition are automatically
   * retried. The worker walks the OUTBOX for entries stuck at terminal
   * statuses (the round-2 steelman fix in PR #97 keeps them live for
   * forensic record), re-runs `writeSentEntryFromOutbox`, and on
   * success tombstones the OUTBOX entry. Set `false` to suppress (e.g.
   * for timer-sensitive unit tests).
   */
  readonly sentReconciliationWorker?: boolean;
  /**
   * Issue #166 P2 #3 — Nostr persistence verification worker.
   *
   * Default `true` (default-ON after soak; flipped under item #5).
   * Auto-installs and starts a {@link NostrPersistenceVerifier} in
   * {@link PaymentsModule.initialize} that periodically re-queries
   * the relay set for SENT-ledger entries' Nostr event ids to detect
   * retention drops (events accepted at publish but later evicted by
   * relay retention policy / restart / segregation). On `'missing'`
   * outcome the verifier re-arms the OUTBOX entry to `'sending'` so
   * the recovery worker republishes via Item #2's path.
   *
   * The worker adds relay query traffic proportional to SENT volume
   * with an LRU-bounded eligibility cap; the per-entry cooldown
   * (default 5 minutes) and the verifier's own backoff prevent
   * runaway probing. Deployments on restrictive relay sets that
   * cannot absorb the steady load should set the flag explicitly to
   * `false` to opt out.
   *
   * The worker self-skips when no SENT entries have `nostrEventId`
   * set (legacy entries pre-#166 P2 #3 wiring) — so the default-ON
   * flip is a safe no-op for wallets with no eligible entries; it
   * just no-ops every cycle.
   */
  readonly nostrPersistenceVerifier?: boolean;
  /**
   * OUTBOX-SEND-FOLLOWUPS item #4 — tombstone garbage collection.
   * Default `true` (default-ON after soak; flipped under item #5).
   *
   * When ON, auto-installs a {@link TombstoneGcWorker} that
   * periodically sweeps tombstoned OUTBOX and SENT slots whose
   * `(now - deletedAt) > retentionMs` (default 30 days) and replaces
   * each marker with a real `db.del(key)` to reclaim OrbitDB log
   * bytes.
   *
   * Tombstones are otherwise permanent (`delete()` writes a marker,
   * not a `db.del()`) — Issue #166 P1 #2 requires the marker for the
   * refuse-write guard. After 30 days of clock time elapsed past the
   * tombstone's `deletedAt`, no concurrent replica can still hold a
   * pre-sync state that would resurrect the slot, so the marker
   * itself is safe to drop.
   *
   * The worker self-skips when no OUTBOX or SENT writer is installed,
   * so the default-ON flip is safe even on legacy-only wallets (it
   * just no-ops every cycle). Set `false` explicitly to suppress
   * (e.g. timer-sensitive unit tests or deployments that prefer
   * manual reclamation).
   */
  readonly tombstoneGcWorker?: boolean;
  /**
   * Issue #166 P2 #1 — orphan-spending-tx AUTO-RECOVERY. Default
   * `false` (opt-in).
   *
   * When OFF, the orphan sweeper retains its Phase-1 detection-only
   * behavior: tokens in `'transferring'` status without an OUTBOX or
   * SENT entry produce `transfer:orphan-spending-detected` events for
   * operator triage.
   *
   * When ON, the sweeper calls a default recovery hook that flips
   * the orphan token's status from `'transferring'` back to
   * `'confirmed'` and persists the change. Recovered orphans produce
   * `transfer:orphan-recovered` events (with strategy
   * `'restore-to-confirmed'`) INSTEAD of the detected event.
   *
   * **Safety trade-off (documented).** The Phase-2 first-cut default
   * recovery assumes the spending commit never reached the
   * aggregator (the common crash window — between source-token
   * mark-as-transferring and OUTBOX entry write). If that assumption
   * is wrong (rare race: commit landed on the aggregator but the
   * OUTBOX write crashed before persist), the recovered token's
   * state hash will not match the aggregator's view; the next
   * operation touching the token will see a state-mismatch
   * rejection. Correctness is preserved at the cost of a confusing
   * error surfaced later. Aggregator cross-check before recovery is
   * a follow-up wave.
   *
   * Default-OFF until soak environments confirm the trade-off is
   * acceptable.
   */
  readonly orphanAutoRecovery?: boolean;
  /**
   * Issue #174 — per-token spent-state rescan worker
   * (UXF-TRANSFER-PROTOCOL §12.3.2). Default `false` (opt-in during
   * soak).
   *
   * When `true`, auto-installs a {@link SpentStateRescanWorker} that
   * periodically asks `oracle.isSpent(currentDestinationStateHash)`
   * for each token in the active pool (`status === 'confirmed'`).
   * Detects off-record spends — e.g. a sibling device with the same
   * keys spent the token without our local snapshot having caught up
   * yet. Emits `transfer:off-record-spent` with a
   * `suspectedSiblingInstance` heuristic flag and routes the token
   * through the disposition writer (`reason: 'off-record-spend'`,
   * §5.3 [E]) so the local view converges with the aggregator.
   *
   * Default-OFF: adds steady aggregator query load proportional to
   * active-pool size. Flip ON only after a 7-day testnet soak
   * confirms no false-positive transitions surface from transient
   * aggregator availability. The worker's per-token throw-back-off
   * (default 3 consecutive throws → 30 min cooldown) protects
   * against runaway probing on stuck tokens.
   *
   * Companion to the reactive `transfer:double-spend-detected`
   * surface (Item #14 Phase 1) and the profile-pointer rescan
   * (§12.3.1 / Item #15). See `docs/uxf/RUNBOOK-SEND-PIPELINE.md`
   * for operator response.
   */
  readonly spentStateRescan?: boolean;
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

/**
 * Task #151 — per-tokenId finalization context stashed by the default
 * processToken closure on instant-mode receive. Consumed by the
 * recipient finalization worker's dispositionWriter callback to
 * rebuild the locally-stored Token with the attached proof.
 *
 * Lifecycle:
 *  - WRITE: processToken closure (instant path), once per token.
 *  - READ:  dispositionWriter VALID branch, after the worker has
 *           polled the aggregator and called the pool's attachProof.
 *  - DELETE: same dispositionWriter branch on success.
 *
 * @internal
 */
interface RecipientFinalizationContext {
  /** Local Token id (from `addToken`); used to find Bob's stored
   *  pending Token by `this.tokens.get(localTokenId)`. */
  readonly localTokenId: string;
  /** SDK source token JSON (state N-1) — needed to re-run
   *  `finalizeTransferToken` once the proof lands. */
  readonly sourceTokenJson: unknown;
  /** Last-tx JSON from the bundle (carries `inclusionProof: null`).
   *  The dispositionWriter callback patches this to use the actual
   *  proof returned by the aggregator before re-running finalization. */
  readonly lastTxJson: Record<string, unknown>;
  /** Aggregator request id hex used to look up the proof. */
  readonly requestIdHex: string;
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
  /**
   * Source token TXF JSON (the `sourceTokenInput` passed to
   * `finalizeReceivedToken`). Required for V6-direct receive jobs so they
   * can survive process restarts (#144) — `finalizeReceivedToken` needs
   * both the source token and the commitment to derive the recipient
   * predicate and call `stClient.finalizeTransaction`. May be omitted for
   * legacy callsites that don't participate in persistence.
   */
  sourceTokenJson?: string;
  startedAt: number;
  attemptCount: number;
  lastAttemptAt: number;
  /** Cumulative attempts across all process lifetimes (steelman FIX G
   *  #144). Sum of every `attemptCount` value the job ever held before
   *  being persisted. Used to enforce a hard cap so a permanently-stuck
   *  receive doesn't poll the aggregator forever. */
  cumulativeAttempts?: number;
  /** Callback when proof is received */
  onProofReceived?: (tokenId: string) => void;
}

/**
 * Persisted (KV-storage) shape of a proof-polling job. Keyed by genesis
 * tokenId + state hash because the in-memory `Token.id` is a UUID at
 * receive time but becomes the genesis tokenId after save→load (see
 * `txfToToken` in `serialization/txf-serializer.ts`).
 *
 * `cumulativeAttempts` is preserved across restarts so a token that has
 * already burned through several `MAX_ATTEMPTS` budgets in prior process
 * lifetimes can be definitively marked invalid (steelman FIX G #144).
 * Without this, every restart hands the same stuck token a fresh 60s
 * budget — an unbounded zombie loop if the aggregator never produces the
 * proof.
 */
interface PersistedProofPollingJob {
  genesisTokenId: string;
  stateHash: string;
  requestIdHex: string;
  commitmentJson: string;
  sourceTokenJson: string;
  startedAt: number;
  attemptCount: number;
  lastAttemptAt: number;
  /** Cumulative attempts across all process lifetimes. Optional for
   *  backward compat with older KV payloads (treated as 0). */
  cumulativeAttempts?: number;
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
  /**
   * Optional UXF bundle-CAR publisher for the `uxf-cid` delivery branch
   * (Issue #200 Phase 1 wiring). When absent, CID-bound delivery falls
   * back to inline delivery (`auto` under cap) or rejects with
   * `IPFS_PUBLISHER_MISSING` (`force-cid`, over-cap auto).
   *
   * MUST satisfy the CID-correspondence contract: returned `cid` equals
   * `extractCarRootCid(carBytes)`. Use `createUxfCarPublisher` from
   * `./transfer/ipfs-publisher.ts` — that's the only contract-compliant
   * publisher. Do NOT roll your own with `pinToIpfs(carBytes)` — that
   * pins the entire CAR envelope as a single raw block under a CID
   * different from the wire's `bundleCid`, making recipient
   * gateway-fetch 404.
   */
  publishToIpfs?: PublishToIpfsCallback;
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
   * Count of `handleIncomingTransfer` invocations currently in flight
   * (incremented at entry, decremented in finally). Lets
   * {@link drainPendingFinalizations} know there are receives mid-pipeline
   * whose tokens have not yet reached `this.tokens` — so the pre-flush
   * drain MUST wait for them.
   *
   * Why this exists: every inbound transfer (UXF v1, COMBINED_TRANSFER V6,
   * INSTANT_SPLIT, Sphere `{transferTx, sourceToken}`, SDK `{token, proof}`,
   * NOSTR-FIRST commitment-only) takes 100–500 ms of network/oracle work
   * BEFORE the resulting Token is `addToken()`-ed into `this.tokens`. The
   * legacy `hasUnconfirmed()` predicate scanned `this.tokens.values()`
   * only; a flush triggered between event arrival and addToken would
   * silently miss the in-flight token. Multi-coin faucet drops surfaced
   * this as a "USDU dropped on cross-device recovery" symptom — the
   * 7th coin's pipeline was still mid-finalization when sync()'s drain
   * took the fast path and skipped.
   */
  private inflightReceiveCount = 0;

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
  /**
   * Lowercase hex of the signing-service publicKey used by
   * `UnmaskedPredicate.create` / `MaskedPredicate.create`. Lazily
   * populated by `createSigningService()` on first call; consumed
   * synchronously by `latestStatePredicateMatchesWallet` (PR #146's
   * balance-model invariant) so the check can run on every reload
   * without re-deriving the signing service.
   */
  private _signingPublicKeyHex: string | null = null;
  private proofPollingInterval: ReturnType<typeof setInterval> | null = null;
  private static readonly PROOF_POLLING_INTERVAL_MS = 2000;  // Poll every 2s
  private static readonly PROOF_POLLING_MAX_ATTEMPTS = 30;   // Max 30 attempts (~60s)
  /** Steelman FIX G (#144): hard cap on cumulative attempts across
   *  process lifetimes. Each restart re-resolves a `pending` token via
   *  `recoverStrandedReceivedTokens`, which would otherwise allow
   *  unbounded retries (60s × restarts). At 5× MAX_ATTEMPTS (~5min of
   *  cumulative polling) we mark the token invalid and emit an alert. */
  private static readonly PROOF_POLLING_MAX_CUMULATIVE_ATTEMPTS = 30 * 5;

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

  /**
   * Steelman FIX F (#144): cached PROXY addresses for our held nametags.
   * Populated lazily by `primeProxyAddressCache()`, consumed
   * synchronously by `isReceivedLegacyPending` to avoid the pre-FIX-F
   * "any nametag + any proxyHash => candidate" loose match that opened
   * a load-time DoS amplification surface (any peer could craft a
   * PROXY://<garbage> TXF and force recovery polling). Stored as the
   * full `PROXY://...` address string so we can do exact-equality match.
   * Cleared on initialize() / destroy().
   */
  private proxyAddressCache: Set<string> = new Set();

  // Storage event subscriptions (push-based sync)
  private storageEventUnsubscribers: (() => void)[] = [];
  private syncDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SYNC_DEBOUNCE_MS = 500;

  /** Sync coalescing: concurrent sync() calls share the same operation.
   *  Options from the first in-flight call are used; subsequent callers
   *  with different options receive the first call's result. */
  private _syncInProgress: Promise<SyncResult> | null = null;

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
      // Issue #166 P2 #4 — SENT-write reconciliation worker. Default-ON:
      // retries SENT writes that failed at the dispatcher's delivered-
      // transition. The worker itself self-skips when either OUTBOX or
      // SENT writer is uninstalled, so default-ON is safe even on
      // legacy-only wallets (it just no-ops every cycle).
      sentReconciliationWorker:
        config?.features?.sentReconciliationWorker ?? true,
      // Issue #166 P2 #3 — Nostr persistence verification worker.
      // Default-ON after item #5 soak: the worker periodically re-
      // queries the relay set for SENT-ledger entries' Nostr event
      // ids to detect retention drops, then re-arms the OUTBOX entry
      // so the recovery worker republishes (Item #2). Query traffic
      // is proportional to eligible SENT volume with an LRU-bounded
      // cap and per-entry cooldown. The worker self-skips when no
      // SENT entries have `nostrEventId` set, so the flip is a safe
      // no-op for legacy-only wallets. Set `false` explicitly to
      // suppress (e.g. restrictive relay sets, timer-sensitive unit
      // tests).
      nostrPersistenceVerifier:
        config?.features?.nostrPersistenceVerifier ?? true,
      // OUTBOX-SEND-FOLLOWUPS item #4 — tombstone GC. Default-ON after
      // soak: the sweeper reclaims OrbitDB log bytes by replacing
      // tombstone markers older than `retentionMs` (default 30 days)
      // with `db.del()` calls. The 30-day default is conservative
      // (longer than any realistic concurrent-replica pre-sync window
      // per Issue #166 P1 #2 safety contract) so the flip is safe.
      // Storage-reclamation is opportunistic — the worker self-skips
      // when no OUTBOX or SENT writer is installed. Set `false`
      // explicitly to suppress (e.g. timer-sensitive unit tests or
      // deployments that prefer manual reclamation).
      tombstoneGcWorker: config?.features?.tombstoneGcWorker ?? true,
      // Issue #166 P2 #1 — orphan-spending auto-recovery. Default-ON
      // after the OUTBOX-SEND-FOLLOWUPS item #1 prerequisite (aggregator
      // cross-check before restore) landed. `defaultOrphanRecovery`
      // queries `oracle.isSpent(sourceStateHash)` before flipping
      // `'transferring'` → `'confirmed'` and escalates to `'manual'`
      // when the aggregator reports the source state spent (i.e. the
      // commit DID land before the crash; local restore would diverge).
      // Without this flip a crashed send leaves the source token
      // unspendable indefinitely and the operator must intervene by
      // hand — with the flip, the cross-checked recovery hook runs
      // automatically on the load-tail orphan sweep. Set `false`
      // explicitly to suppress (e.g. timer-sensitive unit tests).
      orphanAutoRecovery: config?.features?.orphanAutoRecovery ?? true,
      // Issue #174 — per-token spent-state rescan worker
      // (UXF-TRANSFER-PROTOCOL §12.3.2). Default-ON after soak: probes
      // oracle.isSpent for each `'confirmed'` token every ~5 min per
      // token; on `true`, the auto-installed default closure removes
      // the token from the active pool (archive + tombstone + map
      // delete) so the local UI converges with the L3 chain. The
      // per-token throw-back-off + LRU + concurrency cap protect
      // against transient aggregator availability false-positives.
      // Set `false` explicitly to suppress the worker (e.g.
      // timer-sensitive unit tests, cost-sensitive deployments that
      // accept the reactive `transfer:double-spend-detected` surface
      // alone for off-record-spend detection).
      spentStateRescan: config?.features?.spentStateRescan ?? true,
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
    // #144 FIX F: clear PROXY-address cache; re-primed in next load().
    this.proxyAddressCache.clear();

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

    // G6 — auto-install a default SendingRecoveryWorker when the gate
    // is on AND no consumer has already wired one. The auto-installed
    // worker reads from the in-memory `_senderOutboxMap` (same shim
    // FinalizationWorkerSender uses) and re-publishes via the injected
    // transport, preserving `bundleCid` for recipient-side replay LRU
    // (§6.3 / T.3.A idempotency contract).
    //
    // Bootstrap layers (Sphere) MAY override by installing a worker
    // wired against a Profile-backed `OutboxWriter` BEFORE
    // `initialize()` (the `!this.sendingRecoveryWorker` check preserves
    // that contract).
    if (
      this.features.recoveryWorker &&
      this.sendingRecoveryWorker === null
    ) {
      const senderOutboxMap = this._senderOutboxMap;
      const transport = this.deps!.transport;
      const sphereEmit = this.deps!.emitEvent;
      // Issue #97 — capture by closure so reads route through the
      // profile-resident writer when installed. The writer is the
      // source of truth across restarts; falling back to the in-memory
      // map preserves pre-#97 behaviour for callers that haven't wired
      // the profile-backed path yet.
      const getOutboxWriter = (): OutboxWriter | null => this._outboxWriter;
      // Issue #97 (steelman C3) — bind the SENT-write helper for the
      // recovery worker's `update` closure. The object-method-shorthand
      // inside `recoveryDeps.outbox` rebinds `this` to the outbox
      // surface itself, so we can't reach `this.writeSentEntryFromOutbox`
      // from there. Pre-bind at closure construction time.
      const writeSentEntryFromOutbox = this.writeSentEntryFromOutbox.bind(this);
      const recoveryDeps: import('./transfer/sending-recovery-worker').SendingRecoveryWorkerDeps = {
        outbox: {
          async readAllNew(): Promise<ReadonlyArray<UxfTransferOutboxEntry>> {
            const writer = getOutboxWriter();
            if (writer !== null) {
              // Durable source-of-truth read. Tombstoned ids are skipped
              // by readAllNew per OutboxWriter contract.
              return await writer.readAllNew();
            }
            return Array.from(senderOutboxMap.values());
          },
          async update(
            id: string,
            mutator: (prev: UxfTransferOutboxEntry) => UxfTransferOutboxEntry,
          ): Promise<UxfTransferOutboxEntry> {
            const writer = getOutboxWriter();
            let prevStatus: UxfTransferOutboxEntry['status'] | null = null;
            let updated: UxfTransferOutboxEntry;
            if (writer !== null) {
              // Route through the writer so the §7.0 state-machine
              // validator fires AND the Lamport bump rule (§7.1) is
              // honored. Mirror the result into the in-memory map so
              // FinalizationOutboxWriter consumers stay coherent.
              //
              // Issue #97 (steelman C3 fix) — capture the pre-state so
              // we can detect a `'sending' → 'delivered'/'delivered-
              // instant'` arc and fire the SENT-write helper. The
              // dispatcher's transition hook is not involved on the
              // recovery-worker code path, so SENT must be written
              // here or recovered sends silently bypass the ledger.
              updated = await writer.update(id, (prev) => {
                prevStatus = prev.status;
                return mutator(prev);
              });
              senderOutboxMap.set(id, updated);
            } else {
              const existing = senderOutboxMap.get(id);
              if (existing === undefined) {
                throw new SphereError(
                  `SendingRecoveryWorker.update: no entry at id "${id}"`,
                  'VALIDATION_ERROR',
                );
              }
              prevStatus = existing.status;
              const next = mutator(existing);
              const bumped: UxfTransferOutboxEntry = {
                ...next,
                lamport: (existing.lamport ?? 0) + 1,
              };
              senderOutboxMap.set(id, bumped);
              updated = bumped;
            }

            // Issue #97 (C3) — detect terminal-success arc and write
            // SENT inline. CAS guard: only fire when the status
            // ACTUALLY transitioned (mutator may return prev unchanged
            // for self-loop no-ops; see sending-recovery-worker.ts
            // `transitionToDelivered`'s CAS pattern). Self-loop =
            // updated.status === prevStatus → skip.
            const terminalSuccess =
              (updated.status === 'delivered' || updated.status === 'delivered-instant') &&
              prevStatus !== updated.status;
            if (terminalSuccess) {
              // Use the pre-bound helper — the object-method-shorthand
              // here doesn't expose PaymentsModule.this.
              await writeSentEntryFromOutbox(
                updated,
                'sendingRecoveryWorker',
              );
            }

            return updated;
          },
        },
        republish: async (entry: UxfTransferOutboxEntry): Promise<void> => {
          // Re-publish via the same transport surface the original
          // send used. The recipient's replay-LRU short-circuits
          // duplicates by `bundleCid` (§6.3 / T.3.A) so a wasted publish
          // in the racing window is harmless.
          //
          // OUTBOX-SEND-FOLLOWUPS item #2 (final closure, PR #189) —
          // ALWAYS produce a `'uxf-cid'` payload, even when the entry's
          // original `deliveryMethod` was `'car-over-nostr'`. Item #6.a
          // (PR #188) flipped inline-CAR sends to ALSO pin the CAR
          // bytes to the sender's local IPFS node, so the recipient
          // CAN fetch the CID. Without that pin (pre-#6.a entries or
          // wallets without an IPFS publisher) the recipient's CID-
          // fetch path surfaces an error; the entry remains discoverable
          // via the verifier's next retention cycle and the operator
          // can intervene. This is no worse than the pre-PR behavior
          // (which throw → `'failed-transient'` → silent terminal),
          // and it correctly recovers the common case where the pin
          // exists.
          //
          // Custom workers that wire local CAR retention or per-entry
          // pin tracking can install their own republish via
          // `installSendingRecoveryWorker()` and refuse the downgrade
          // when their richer signals indicate the CID is unfetchable.
          switch (entry.deliveryMethod) {
            case 'cid-over-nostr':
            case 'car-over-nostr': {
              // The CID is the durable handle in both cases:
              //  - 'cid-over-nostr': original send pinned the CAR to
              //    IPFS before publishing the CID-by-reference shape.
              //  - 'car-over-nostr' (post-#6.a): inline send fired a
              //    best-effort local pin via the orchestrator's Step
              //    8.5 path; the CID is fetchable from the sender's
              //    IPFS node.
              //  - 'car-over-nostr' (pre-#6.a): NO local pin; the
              //    recipient's CID fetch will fail. The verifier's
              //    next cycle re-arms the entry (still at `'delivered'`
              //    OR re-armed back to `'sending'`); operator triage
              //    catches stuck cycles via tombstone GC.
              //
              // `mode === 'txf'` is a legacy outbox-mode discriminator
              // that does NOT belong to UXF wire payloads — map it to
              // `'instant'` for the advisory `mode` field; recipients
              // ignore it (§5.6).
              const payloadMode: 'conservative' | 'instant' =
                entry.mode === 'txf' ? 'instant' : entry.mode;
              await transport.sendTokenTransfer(
                entry.recipientTransportPubkey,
                {
                  kind: 'uxf-cid',
                  version: '1.0',
                  mode: payloadMode,
                  bundleCid: entry.bundleCid,
                  tokenIds: entry.tokenIds,
                  ...(typeof entry.memo === 'string'
                    ? { memo: entry.memo }
                    : {}),
                },
              );
              return;
            }
            case 'txf-legacy': {
              throw new SphereError(
                `SendingRecoveryWorker default republish cannot recover entry ${entry.id}: ` +
                  `deliveryMethod='txf-legacy' is a single-token legacy wire shape that does ` +
                  `not round-trip through the UXF payload union. Operator triage required.`,
                'VALIDATION_ERROR',
              );
            }
            default: {
              // Defense-in-depth: refuse to publish an unknown
              // delivery method as `'uxf-cid'` blindly. This branch
              // is unreachable today; if a new arm is added to
              // `UxfTransferOutboxEntry.deliveryMethod` and lands in
              // the outbox before this switch is updated, fail-closed.
              const _exhaustive: never = entry.deliveryMethod;
              throw new SphereError(
                `SendingRecoveryWorker default republish: unsupported ` +
                  `deliveryMethod=${String(_exhaustive)} on entry ${entry.id}`,
                'VALIDATION_ERROR',
              );
            }
          }
        },
        emit: sphereEmit,
      };
      this.sendingRecoveryWorker = new SendingRecoveryWorker(recoveryDeps);
      this.sendingRecoveryWorker.start();
      logger.debug(
        'Payments',
        'Default SendingRecoveryWorker auto-installed (recoveryWorker default-on)',
      );
    } else if (
      this.features.recoveryWorker &&
      this.sendingRecoveryWorker !== null
    ) {
      // Pre-installed by the bootstrap layer — start it.
      this.sendingRecoveryWorker.start();
    }

    // Issue #166 P2 #4 — auto-install the SENT-write reconciliation
    // worker. Mirrors the SendingRecoveryWorker pattern above but with
    // closures over the OUTBOX/SENT writer providers so the worker
    // observes hot-swaps and the writer-uninstall arc at destroy. The
    // worker itself self-skips when either writer is null, so the
    // start() call is safe even before the bootstrap layer (Sphere)
    // installs the writers.
    if (
      this.features.sentReconciliationWorker &&
      this.sentReconciliationWorker === null
    ) {
      // Pre-bind the SENT-write helper so the closure in
      // `recDeps.writeSentEntry` doesn't lose `this` — same rationale
      // as the SendingRecoveryWorker's C3 fix above.
      const writeSentEntryFromOutbox =
        this.writeSentEntryFromOutbox.bind(this);
      const recDeps: SentReconciliationWorkerDeps = {
        outboxProvider: (): Pick<OutboxWriter, 'readAllNew' | 'delete'> | null =>
          this._outboxWriter,
        sentProvider: (): Pick<SentLedgerWriter, 'readOne'> | null =>
          this._sentLedgerWriter,
        writeSentEntry: writeSentEntryFromOutbox,
        emit: this.deps!.emitEvent,
      };
      this.sentReconciliationWorker = new SentReconciliationWorker(recDeps);
      this.sentReconciliationWorker.start();
      logger.debug(
        'Payments',
        'Default SentReconciliationWorker auto-installed (sentReconciliationWorker default-on)',
      );
    } else if (
      this.features.sentReconciliationWorker &&
      this.sentReconciliationWorker !== null
    ) {
      // Pre-installed by the bootstrap layer — start it.
      this.sentReconciliationWorker.start();
    }

    // Issue #166 P2 #3 — auto-install the Nostr persistence
    // verification worker. Mirrors the recovery / reconciliation
    // worker patterns above. Default-ON after item #5 soak; the
    // worker self-skips entries that lack `nostrEventId` (legacy
    // SENT entries from before the dispatcher capture wiring), and
    // routes verify() through transport.verifyTokenTransferRetained
    // when the transport implements it (else 'unverifiable' which
    // never produces a false-positive warning).
    if (
      this.features.nostrPersistenceVerifier &&
      this.nostrPersistenceVerifier === null
    ) {
      const transport = this.deps!.transport;
      const sphereEmit = this.deps!.emitEvent;
      const verifierDeps: NostrPersistenceVerifierDeps = {
        sentProvider: (): Pick<SentLedgerWriter, 'readAll'> | null =>
          this._sentLedgerWriter,
        // OUTBOX-SEND-FOLLOWUPS item #2 — thread the OUTBOX writer so
        // the verifier can transition live `delivered`/`delivered-
        // instant` entries back to `'sending'` on retention drops.
        // The SendingRecoveryWorker then republishes via its existing
        // scan loop (item #6's deliveryMethod-aware closure handles
        // CAR/TXF entries safely).
        outboxProvider: (): Pick<OutboxWriter, 'update'> | null =>
          this._outboxWriter,
        verify: async (entry: UxfSentLedgerEntry): Promise<VerifyOutcome> => {
          if (
            typeof entry.nostrEventId !== 'string' ||
            entry.nostrEventId.length === 0
          ) {
            return 'unverifiable';
          }
          if (typeof transport.verifyTokenTransferRetained !== 'function') {
            // Transport does not implement the optional verify
            // method — the worker can't make progress here, but
            // 'unverifiable' means "retry next cycle" so no false
            // warnings are emitted.
            return 'unverifiable';
          }
          try {
            return await transport.verifyTokenTransferRetained(
              entry.nostrEventId,
            );
          } catch {
            // The transport contract says "never throw," but
            // defense-in-depth: a throw here degrades to
            // unverifiable rather than missing.
            return 'unverifiable';
          }
        },
        emit: sphereEmit,
      };
      this.nostrPersistenceVerifier = new NostrPersistenceVerifier(verifierDeps);
      this.nostrPersistenceVerifier.start();
      logger.debug(
        'Payments',
        'Default NostrPersistenceVerifier auto-installed (nostrPersistenceVerifier opt-in flag ON)',
      );
    } else if (
      this.features.nostrPersistenceVerifier &&
      this.nostrPersistenceVerifier !== null
    ) {
      this.nostrPersistenceVerifier.start();
    }

    // Issue #174 — auto-install the per-token spent-state rescan worker
    // (UXF-TRANSFER-PROTOCOL §12.3.2). Default-OFF; when ON the worker
    // probes oracle.isSpent for each `'confirmed'` token to detect
    // off-record spends from sibling instances of the same wallet.
    // `transitionToAudit` defaults to {@link defaultSpentStateTransition}
    // (local Token.status flip + archive + tombstone via removeToken);
    // callers that need to route through a production-wired
    // `DispositionWriter.write()` (future, once that wiring lands in
    // production) override via {@link setSpentStateRescanTransitionToAudit}.
    // The `oracleProvider` closure reads `this.deps?.oracle` lazily so
    // a future `deps` re-init (e.g. oracle swap on reconnect) is
    // observed; same closure pattern as `sentProvider` / `outboxProvider`
    // for consistency.
    if (
      this.features.spentStateRescan &&
      this.spentStateRescanWorker === null
    ) {
      const sphereEmit = this.deps!.emitEvent;
      const rescanDeps: SpentStateRescanWorkerDeps = {
        tokensProvider: (): Iterable<Token> => this.tokens.values(),
        oracleProvider: (): {
          readonly isSpent: (stateHash: string) => Promise<boolean>;
        } | null => {
          const oracle = this.deps?.oracle;
          return oracle !== undefined && typeof oracle.isSpent === 'function'
            ? oracle
            : null;
        },
        extractCurrentStateHash: (token: Token): string =>
          extractStateHashFromSdkData(token.sdkData),
        sentProvider: (): Pick<SentLedgerWriter, 'contains'> | null =>
          this._sentLedgerWriter,
        outboxProvider: (): Pick<OutboxWriter, 'readAll'> | null =>
          this._outboxWriter,
        transitionToAudit:
          this._spentStateRescanTransitionToAudit ??
          this.defaultSpentStateTransition.bind(this),
        emit: sphereEmit,
        logger: {
          warn: (message: string, context?: Record<string, unknown>): void => {
            logger.warn('Payments', `${message}`, context);
          },
        },
      };
      this.spentStateRescanWorker = new SpentStateRescanWorker(rescanDeps);
      this.spentStateRescanWorker.start();
      logger.debug(
        'Payments',
        'Default SpentStateRescanWorker auto-installed (spentStateRescan opt-in flag ON)',
      );
    } else if (
      this.features.spentStateRescan &&
      this.spentStateRescanWorker !== null
    ) {
      this.spentStateRescanWorker.start();
    }

    // OUTBOX-SEND-FOLLOWUPS item #4 — auto-install the tombstone GC
    // worker. Default-ON after item #5 soak: the worker periodically
    // reclaims storage occupied by tombstones whose retention window
    // has elapsed. Both writers self-skip when no writer is installed,
    // so the start() call is safe even before bootstrap installs them.
    if (
      this.features.tombstoneGcWorker &&
      this.tombstoneGcWorker === null
    ) {
      const gcDeps: TombstoneGcWorkerDeps = {
        outboxProvider: (): Pick<OutboxWriter, 'gcExpiredTombstones'> | null =>
          this._outboxWriter,
        sentProvider: (): Pick<SentLedgerWriter, 'gcExpiredTombstones'> | null =>
          this._sentLedgerWriter,
        logger: {
          warn: (message: string, context?: Record<string, unknown>): void => {
            logger.warn('Payments', `${message}`, context);
          },
        },
      };
      this.tombstoneGcWorker = new TombstoneGcWorker(gcDeps);
      this.tombstoneGcWorker.start();
      logger.debug(
        'Payments',
        'Default TombstoneGcWorker auto-installed (tombstoneGcWorker opt-in flag ON)',
      );
    } else if (
      this.features.tombstoneGcWorker &&
      this.tombstoneGcWorker !== null
    ) {
      this.tombstoneGcWorker.start();
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
        //
        // Phase 9.6.A advisory-vs-claimed filter (steelman fix #160).
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
        // **Why ctx.isClaimed (not a Set lookup)**: previously this gate
        // re-derived the membership question by building a Set from
        // verified.claimedTokens and asking `has(tokenRoot.tokenId)`. The
        // pool already knows which list the root came from — it iterates
        // claimedTokens and advisoryUnclaimedRoots separately — so the
        // dispatcher now passes the discriminator directly, and the gate
        // reduces to a single boolean check. The discriminator approach
        // is also robust against a hostile sender shipping the SAME
        // tokenId in BOTH lists (the verifier should reject; defense-in-
        // depth here is to trust only ctx.isClaimed === true for the
        // claimed-token write path).
        //
        // **Advisory-only contract** (when ctx.isClaimed === false):
        //   - MUST NOT trigger sender-attribution events
        //     (`transfer:incoming`) or the `RECEIVED` history entry —
        //     those would falsely credit the bundle's sender for tokens
        //     the sender never claimed to deliver.
        //   - MUST NOT be eligible for cascade source-side write-back
        //     (no `_sent` / outbox entry, no `transfer:confirmed` for the
        //     advisory root).
        //   - MUST NOT count toward the sender's delivery acknowledgement
        //     ledger.
        // The default closure satisfies this by returning early below; any
        // future "found money" credit path that handles advisory roots
        // MUST be wired in a separate branch with explicit policy.
        if (!ctx.isClaimed) {
          logger.debug(
            'Payments',
            `UXF processToken: skipping advisoryUnclaimedRoot ${tokenRoot.tokenId.slice(0, 16)} — not claimed for this recipient`,
            {
              bundleCid: ctx.bundleCid.slice(0, 16),
              tokenId: tokenRoot.tokenId.slice(0, 16),
            },
          );
          return;
        }
        // [DIAG-UXF-RECV] bundle-level: how many tokens are claimed for this recipient?
        logger.debug('Payments', '[DIAG-UXF-RECV] processToken entry (claimed)', {
          bundleCid: ctx.bundleCid.slice(0, 16),
          claimedCount: verified.claimedTokens.length,
          claimedTokenIds: verified.claimedTokens.map((r) => r.tokenId.slice(0, 16)),
          thisTokenId: tokenRoot.tokenId.slice(0, 16),
          isClaimed: true,
        });

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
          // Task #151 — recipient finalization context, populated when
          // hasNullProof === true so the recipient worker can rebuild
          // the SDK Token once the proof lands and flip status →
          // 'confirmed'.
          // Wave 4 fix — also stash the canonical transactionHash + authenticator
          // so the recipient `_recipientRequestContextMap` carries values that
          // match the aggregator's proof on §6.1 race-lost compare. Wave 2
          // populated the map with the requestId (wrong) which made every
          // successful poll fire race-lost.
          let pendingFinalizationCtx: {
            sourceTokenJson: unknown;
            lastTxJson: Record<string, unknown>;
            requestIdHex: string;
            transactionHash: string;
            authenticator: string;
          } | null = null;

          if (txArray.length > 0) {
            const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const trustBase = (this.deps!.oracle as any).getTrustBase?.();
            const lastTxJson = txArray.at(-1) as Record<string, unknown> | undefined;
            // Canonical default: missing `inclusionProof` field === null. The
            // V5/V6 protocol treats absence and explicit-null as the same
            // pending signal; the strict `=== null` check below misclassifies
            // bundles where the sender omits the field rather than setting
            // it explicitly to null, sending those through the 2a (finalize)
            // path that needs a real proof and falls through to the
            // "confirmed + sender's predicate" fallback — which the
            // balance-model invariant in `loadFromStorageData` then archives.
            const lastTxProof =
              lastTxJson === undefined
                ? null
                : lastTxJson.inclusionProof === undefined
                  ? null
                  : lastTxJson.inclusionProof;
            const hasNullProof = lastTxProof === null;

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
                let sourceTokenJson = verified.pkg.assembleAtState(
                  tokenRoot.tokenId,
                  txCount - 1,
                );

                // Issue #197 — proactively REPAIR any proofless
                // intermediate tx(s) in the source chain BEFORE
                // SdkToken.fromJSON (which throws on null
                // inclusionProof and used to be silently swallowed by
                // the outer try/catch, leaving the token wedged with
                // status='confirmed' but sdkData in sender-predicate
                // form — every subsequent Token.verify(trustBase)
                // would then reject the token).
                //
                // Our SDK's `selectSources` now finalizes via the same
                // `finalizeSourceTokenChain` routine before shipping
                // (PaymentsModule.ts dispatchUxfConservativeSend), but
                // this is a SECOND line of defense for bundles
                // arriving from senders that lack the fix (older SDK
                // versions, custom integrations). On unrecoverable
                // failure we surface a structured operator-alert
                // instead of silently wedging.
                const sourceTokenJsonStr = JSON.stringify(sourceTokenJson);
                const prooflessIntermediates =
                  extractPendingChainFromSdkData(sourceTokenJsonStr);
                if (prooflessIntermediates.length > 0) {
                  try {
                    const syntheticWrap: Token = {
                      id: tokenRoot.tokenId,
                      coinId: 'unknown',
                      symbol: '',
                      name: '',
                      decimals: 0,
                      amount: '0',
                      status: 'pending',
                      createdAt: Date.now(),
                      updatedAt: Date.now(),
                      sdkData: sourceTokenJsonStr,
                    };
                    const repaired = await finalizeSourceTokenChain(
                      syntheticWrap,
                      this.deps!.oracle,
                    );
                    if (
                      repaired.sdkData !== undefined &&
                      repaired.sdkData !== sourceTokenJsonStr
                    ) {
                      sourceTokenJson = JSON.parse(repaired.sdkData);
                    } else {
                      // finalizeSourceTokenChain returned the same ref —
                      // either the chain was already finalized (shouldn't
                      // happen given prooflessIntermediates.length > 0)
                      // or repair surfaced no proofs. Treat as failure.
                      throw new Error(
                        'finalizeSourceTokenChain returned no change despite ' +
                          `${prooflessIntermediates.length} proofless intermediate(s)`,
                      );
                    }
                  } catch (repairErr) {
                    const errMsg =
                      repairErr instanceof Error ? repairErr.message : String(repairErr);
                    logger.warn(
                      'Payments',
                      'Issue #197: received bundle with proofless intermediate tx(s); aggregator repair failed',
                      {
                        tokenId: tokenRoot.tokenId.slice(0, 16),
                        prooflessIndexes: prooflessIntermediates.map((p) => p.txIndex),
                        err: errMsg,
                      },
                    );
                    try {
                      this.deps!.emitEvent('transfer:operator-alert', {
                        code: 'proof-throw',
                        tokenId: tokenRoot.tokenId,
                        bundleCid: ctx.bundleCid,
                        senderTransportPubkey: ctx.senderTransportPubkey,
                        message:
                          `Issue #197: received bundle with proofless intermediate tx(s) at ` +
                          `indexes=[${prooflessIntermediates.map((p) => p.txIndex).join(',')}] ` +
                          `in source chain of token ${tokenRoot.tokenId.slice(0, 16)}; ` +
                          `aggregator repair failed: ${sanitizeReasonString(errMsg)}. ` +
                          'Token will NOT be ingested (would have wedged with sender-predicate sdkData).',
                      });
                    } catch {
                      // emitter unavailable — diagnostic-only path
                    }
                    return;
                  }
                }

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
                  //    - Stash a finalization context so the recipient
                  //      worker (Task #151) can rebuild the SDK Token
                  //      once the aggregator returns the proof.
                  tokenData = { ...assembledJson, state: recipientState.toJSON() };
                  tokenStatus = 'pending';

                  // Wave 5 fix — Task #151 / R1 (dead-code).
                  //
                  // Wave 4 R1 attempted to mirror the sender wiring by
                  // calling `TransferCommitment.fromJSON(lastTxJson)`.
                  // That ALWAYS throws: `lastTxJson` has the
                  // TransferTransaction shape `{data, inclusionProof}`
                  // (see line ~7759 where the SENDER builds the bundle:
                  // `transferTxJson = { data: commitment.toJSON()
                  // .transactionData, inclusionProof: null }`), NOT the
                  // TransferCommitment shape `{requestId,
                  // transactionData, authenticator}` that `fromJSON`
                  // requires. `TransferCommitment.isJSON` returns false
                  // and `fromJSON` raises `InvalidJsonStructureError`.
                  // The outer try/catch silently swallowed the throw,
                  // `pendingFinalizationCtx` stayed null, the entire
                  // downstream wire-up was dead code at runtime, and
                  // §6.1 race-lost still fired on every successful
                  // recipient poll (because `_recipientRequestContextMap`
                  // never received a real entry).
                  //
                  // The correct derivation paths:
                  //
                  //   1. `transactionHash` — the canonical 68-char SDK
                  //      DataHash imprint hex of the transfer-tx-data.
                  //      The aggregator anchors EXACTLY this value in
                  //      `proof.transactionHash` (see
                  //      `StateTransitionClient.submitTransferCommitment`:
                  //      `client.submitCommitment(commitment.requestId,
                  //      await commitment.transactionData.calculateHash(),
                  //      commitment.authenticator)`). We compute it
                  //      directly from `txData.calculateHash().toJSON()`
                  //      — `txData` was already parsed via
                  //      `TransferTransactionData.fromJSON(lastTxJson.data)`
                  //      at line ~1591, so this path is independent of
                  //      `inclusionProof: null`.
                  //
                  //   2. `requestId` — `RequestId.create(senderPublicKey,
                  //      sourceStateHash)` (matches
                  //      `TransferCommitment.create`). The recipient
                  //      derives `senderPublicKey` from the source-state
                  //      predicate (`PredicateEngineService.createPredicate
                  //      (state.predicate).publicKey`), and
                  //      `sourceStateHash = txData.sourceState.calculateHash()`.
                  //
                  //   3. `authenticator` — by design EMPTY (`''`) on the
                  //      queue entry. Wave 6 reverted Wave 5's sender-
                  //      side embed: the IPLD wire format
                  //      (deconstructTransferData → assembleTransactionData)
                  //      does NOT preserve any `data.authenticator` field,
                  //      so the embed was dead code (the recipient always
                  //      observed `undefined`). The queue-entry
                  //      `authenticator` is therefore metadata-only —
                  //      `canonicalAuthenticatorEquals` (import-inclusion-
                  //      proof.ts) returns `'match'` when one side is
                  //      empty, so the §6.3 binding compare degrades to
                  //      `transactionHash`-only without rejecting valid
                  //      proofs.
                  //
                  //      Defense layout:
                  //        - §6.1 race-lost: keyed by `transactionHash`
                  //          alone — fully unaffected by the empty
                  //          authenticator.
                  //        - §6.3 most-recent-proof: compares the
                  //          aggregator-served authenticator on the
                  //          ATTACHED proof vs the aggregator-served
                  //          authenticator on the OBSERVED poll — both
                  //          come from the aggregator, never from the
                  //          queue entry. Empty queue authenticator is
                  //          benign.
                  //        - Forged-authenticator defense is provided by
                  //          trust-base verification: the proof verifier
                  //          rejects unauthentic proofs with
                  //          `PATH_INVALID` / `NOT_AUTHENTICATED` BEFORE
                  //          the binding compare runs.
                  try {
                    // (a) Canonical transactionHash imprint hex (matches
                    //     the aggregator's stored value).
                    const txDataHash = await txData.calculateHash();
                    const txHashImprintHex = txDataHash.toJSON();

                    // (b) Canonical requestId. The source-state predicate
                    //     was already loaded via `sourceToken.state.predicate`,
                    //     but we use the SDK's `PredicateEngineService` for
                    //     symmetry and to extract `publicKey` cleanly.
                    const senderPredicate = await PredicateEngineService.createPredicate(
                      txData.sourceState.predicate,
                    );
                    // The DefaultPredicate base class exposes a
                    // `publicKey: Uint8Array` getter (see
                    // node_modules/@unicitylabs/state-transition-sdk/lib/
                    // predicate/embedded/DefaultPredicate.d.ts). The
                    // `IPredicate` interface that `createPredicate`
                    // returns does NOT declare `publicKey` (it's only on
                    // `MaskedPredicate`/`UnmaskedPredicate` concrete
                    // classes), so we narrow via runtime check + cast.
                    const senderPubkey = (senderPredicate as unknown as { publicKey?: Uint8Array }).publicKey;
                    if (!(senderPubkey instanceof Uint8Array) || senderPubkey.length === 0) {
                      const engineStr = String(
                        (senderPredicate as unknown as { engine?: unknown }).engine ?? 'unknown',
                      );
                      throw new Error(
                        `Sender predicate (engine=${engineStr}) does not expose a publicKey — cannot derive recipient requestId for instant-mode finalization`,
                      );
                    }
                    const sourceStateHash = await txData.sourceState.calculateHash();
                    const reqIdObj = await RequestId.create(senderPubkey, sourceStateHash);
                    const reqIdHex = reqIdObj.toJSON();

                    // (c) Authenticator — by design ABSENT at ingest time.
                    //
                    // Wave 6: the §6.3 binding compare's queue-entry
                    // `authenticator` field is metadata-only. The IPLD
                    // wire format (deconstructTransferData →
                    // assembleTransactionData) does NOT preserve any
                    // `data.authenticator` field — only the canonical
                    // {recipient, salt, recipientDataHash, message,
                    // nametagRefs} pass through. Wave 5's sender-side
                    // embed was therefore dead code (the recipient
                    // always saw `undefined`). We degrade gracefully
                    // here:
                    //
                    //   - `transactionHash` byte equality (§6.1 race-lost
                    //     and §6.3 forbidden-case binding) is the
                    //     load-bearing check; we already populate it
                    //     above.
                    //   - `authenticator` is best-effort defense-in-
                    //     depth; the §6.3 most-recent-proof check
                    //     compares the ATTACHED proof's authenticator
                    //     vs the OBSERVED poll's authenticator — both
                    //     come from the AGGREGATOR, not from the queue
                    //     entry. Leaving the queue entry's authenticator
                    //     null is therefore safe.
                    //
                    // `canonicalAuthenticatorEquals` (import-inclusion-
                    // proof.ts) returns `'match'` when the queue side
                    // is empty/null so the importInclusionProof
                    // operator path remains usable. Production bundles
                    // never carry `data.authenticator`; what's load-
                    // bearing is `transactionHash`.
                    const authenticatorJsonStr = '';

                    pendingFinalizationCtx = {
                      sourceTokenJson,
                      lastTxJson,
                      requestIdHex: reqIdHex,
                      transactionHash: txHashImprintHex,
                      authenticator: authenticatorJsonStr,
                    };
                  } catch (deriveErr) {
                    // Hard failure to derive the canonical values. The
                    // recipient worker cannot finalize this token; we
                    // surface this as `transfer:operator-alert` (NOT a
                    // silent log) per Wave 5 R1: silent dead-code is
                    // exactly the bug we are closing.
                    const errMsg = deriveErr instanceof Error ? deriveErr.message : String(deriveErr);
                    logger.warn(
                      'Payments',
                      'Wave 5 R1: failed to derive recipient finalization context (transactionHash + requestId)',
                      {
                        tokenId: tokenRoot.tokenId.slice(0, 16),
                        err: errMsg,
                      },
                    );
                    try {
                      this.deps!.emitEvent('transfer:operator-alert', {
                        code: 'structural',
                        tokenId: tokenRoot.tokenId,
                        message:
                          `Wave 5 R1 hard-fail: cannot derive recipient ` +
                          `finalization context for tokenId=${tokenRoot.tokenId.slice(0, 16)} — ` +
                          `recipient worker will not enqueue this token. ` +
                          `Cause: ${errMsg}`,
                      });
                    } catch {
                      // emitter unavailable — diagnostic only path
                    }
                  }
                }
              } catch (finalizeErr) {
                // If recipient-side finalization fails unexpectedly, fall
                // back to the assembled JSON. Pre-fix this kept
                // `tokenStatus = 'confirmed'` to preserve previous
                // behavior — but after PR #146 landed the #144 L3
                // balance-model invariant, a token with the SENDER's
                // state.predicate persisted at `'confirmed'` gets
                // immediately archived by `loadFromStorageData`. The
                // user-visible effect is faucet-received tokens
                // disappearing from `payments balance` despite the
                // history entry showing the inbound. Fix: if the
                // assembled token's last tx has a null/missing
                // inclusionProof, classify as `'pending'` so the
                // recovery flow can reattempt finalization on a
                // subsequent load.
                logger.warn(
                  'Payments',
                  'UXF recipient-side finalization failed, falling back to assembled JSON',
                  { tokenId: tokenRoot.tokenId.slice(0, 16), err: finalizeErr },
                );
                tokenData = assembledJson;
                if (hasNullProof) {
                  tokenStatus = 'pending';
                }
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

            // Task #151 — Enqueue PENDING entries for the recipient
            // finalization worker. This is the "missing wire" fixed
            // by #151: previously the instant-mode receive path stored
            // the token as `'pending'` but never enqueued it for
            // proof-attachment, so the token stayed in `'pending'`
            // forever and re-spend phases failed with
            // SEND_INSUFFICIENT_BALANCE.
            //
            // The enqueue is a best-effort fire-and-forget: a missing
            // queue (no recipientUxf or test stub without oracle) is
            // a no-op. The worker's processOneToken is also fire-and-
            // forget — errors propagate through `transfer:operator-
            // alert` events, never throw out of processToken.
            if (
              tokenStatus === 'pending' &&
              pendingFinalizationCtx !== null &&
              this._recipientFinalizationQueue !== null &&
              this.finalizationWorkerRecipient !== null
            ) {
              try {
                const tokenIdForQueue = incomingTokenId ?? token.id;
                const pCtx = pendingFinalizationCtx;
                const reqId = pCtx.requestIdHex;

                // Stash the finalization context for the dispositionWriter
                // VALID branch.
                this._recipientFinalizationContext.set(tokenIdForQueue, {
                  localTokenId: token.id,
                  sourceTokenJson: pCtx.sourceTokenJson,
                  lastTxJson: pCtx.lastTxJson,
                  requestIdHex: reqId,
                });

                // Stash the resolver context so the worker's
                // RequestContextResolver can find the (transactionHash,
                // authenticator) pair on the §6.1 race-lost compare.
                // The recipient never re-submits (the aggregator
                // already has the commitment from the sender), but the
                // resolver still needs to surface a non-null
                // RequestContext.
                //
                // Wave 4 fix — populate with the REAL canonical
                // transactionHash + authenticator derived from the
                // SDK commitment in pendingFinalizationCtx. Previously
                // both fields were filled with the requestId / empty
                // string, which made §6.1 fire race-lost on every
                // successful aggregator poll (because the proof's
                // transactionHash is the tx-data-hash imprint, not the
                // requestId).
                if (!this._recipientRequestContextMap.has(reqId)) {
                  this._recipientRequestContextMap.set(reqId, {
                    transactionHash: pCtx.transactionHash,
                    authenticator: pCtx.authenticator,
                    nextEntryRest: { status: 'valid' as const },
                  });
                }

                const addrId = (() => {
                  const directAddr = this.deps!.identity.directAddress;
                  return typeof directAddr === 'string' && directAddr.length > 0
                    ? computeAddressId(directAddr)
                    : this.deps!.identity.chainPubkey;
                })();

                // Enqueue one entry per unfinalized tx. Today the
                // default closure handles only the LAST tx (instant
                // mode is K=1). Chain-mode (K>1) instant tokens are
                // not yet exercised by this default; the entry-id
                // composite (`${tokenId}:${txIndex}`) reserves the
                // shape for future K>1 wiring.
                // Wave 4 fix — populate with canonical transactionHash +
                // authenticator from pendingFinalizationCtx (real values
                // derived from the SDK commitment), NOT requestId / empty.
                const entry: FinalizationQueueEntry = {
                  entryId: entryIdFor(tokenIdForQueue, txArray.length - 1),
                  tokenId: tokenIdForQueue,
                  bundleCid: ctx.bundleCid, // outer ctx = ProcessTokenContext
                  txIndex: txArray.length - 1,
                  commitmentRequestId: reqId,
                  transactionHash: pCtx.transactionHash,
                  authenticator: pCtx.authenticator,
                  submittedAt: Date.now(),
                  createdAt: Date.now(),
                  submitRetryCount: 0,
                  proofErrorCount: 0,
                  status: 'pending',
                  source: 'received',
                };
                await this._recipientFinalizationQueue.add(addrId, entry);

                // G7 — mirror the in-memory context Maps to persisted
                // storage so a crash between enqueue and finalization
                // does not erase the lookup keys the dispositionWriter
                // VALID branch needs. Best-effort + fire-and-forget:
                // the in-memory Maps remain authoritative for the
                // current process (they were already populated above).
                // The persisted records exist solely to survive a
                // crash; awaiting them on the recipient hot path
                // serializes N OrbitDB writes per token batch under
                // parallel load and was the dominant source of the
                // 3× e2e regression in profile-multi-device-sync.
                // Persistence failure is non-fatal — only cross-
                // restart safety degrades.
                if (this._recipientContextStorage !== null) {
                  const ctxStorage = this._recipientContextStorage;
                  const finalizationCtx = {
                    localTokenId: token.id,
                    sourceTokenJson: pCtx.sourceTokenJson,
                    lastTxJson: pCtx.lastTxJson,
                    requestIdHex: reqId,
                  };
                  const requestCtx = {
                    transactionHash: pCtx.transactionHash,
                    authenticator: pCtx.authenticator,
                    nextEntryRest: { status: 'valid' as const },
                  };
                  void ctxStorage
                    .writeFinalizationContext(addrId, tokenIdForQueue, finalizationCtx)
                    .catch((persistErr) => {
                      logger.warn(
                        'Payments',
                        `G7: failed to persist finalization context for ${tokenIdForQueue.slice(0, 16)}: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                      );
                    });
                  void ctxStorage
                    .writeRequestContext(addrId, reqId, requestCtx)
                    .catch((persistErr) => {
                      logger.warn(
                        'Payments',
                        `G7: failed to persist request context for ${tokenIdForQueue.slice(0, 16)}: ${persistErr instanceof Error ? persistErr.message : String(persistErr)}`,
                      );
                    });
                }

                // Fire-and-forget drive of the worker. The worker
                // handles its own concurrency caps + per-token mutex.
                const worker = this.finalizationWorkerRecipient;
                void worker
                  .processOneToken(tokenIdForQueue)
                  .catch((werr) => {
                    logger.debug(
                      'Payments',
                      `Task #151: recipient worker.processOneToken threw for ${tokenIdForQueue.slice(0, 16)}: ${werr instanceof Error ? werr.message : String(werr)}`,
                    );
                  });
              } catch (enqErr) {
                // Enqueue failure is non-fatal — the token is still
                // stored as 'pending' and the user can re-trigger via
                // payments.receive({ finalize: true }) on the legacy
                // path.
                logger.warn(
                  'Payments',
                  `Task #151: failed to enqueue PENDING finalization entry for ${tokenRoot.tokenId.slice(0, 16)}`,
                  { err: enqErr instanceof Error ? enqErr.message : String(enqErr) },
                );
              }
            }
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

    // Task #169 — Per-initialize AbortController. Aborted in destroy()
    // BEFORE awaiting worker.stop() so in-flight runFinalizationCycle
    // invocations + their pending sleep(...) timers terminate
    // deterministically. Recreated each initialize() because aborted
    // signals cannot be reset.
    this._workerAbortController = new AbortController();

    // Round 7 (FIX 3) — Shared per-tokenId mutex. Constructed once per
    // initialize() and plumbed into the sender + recipient finalization
    // workers AND the operator escape-hatch InclusionProofImporter so
    // all three paths serialize against the same read-decide-write
    // window when they touch the same tokenId. Without this, a
    // concurrent `finalizeTransferToken(X)` and `importInclusionProof(X)`
    // race in their respective per-tokenId guards (each builder
    // previously created its own fresh PerTokenMutex), corrupting the
    // manifest's audit trail or re-queuing duplicate K-1 entries.
    this._sharedPerTokenMutex = new PerTokenMutex();

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
          // Task #169 — wire the per-initialize AbortController's signal
          // through to the worker so destroy() can cancel in-flight
          // submit/poll cycles + sleep timers.
          signal: this._workerAbortController.signal,
          // Round 7 (FIX 3) — share per-tokenId mutex with recipient
          // worker + operator importer so all three paths serialize
          // against the same read-decide-write window.
          perTokenMutex: this._sharedPerTokenMutex,
        });
        this.finalizationWorkerSender.start();
        logger.debug(
          'Payments',
          'Default FinalizationWorkerSender auto-installed (senderUxf default-on)',
        );
      }
    }

    // Task #151 — auto-install the recipient-side finalization worker
    // when `recipientUxf` is on AND `finalizationWorker` is on AND no
    // consumer has already installed one via
    // `installFinalizationWorkerRecipient()`.
    //
    // The auto-installed worker uses lightweight in-memory adapters
    // (FinalizationQueue + manifestCas + tombstones + pool + queue +
    // stub revaluateHooks/cascadeWalker). Its dispositionWriter is
    // wired back to PaymentsModule via the
    // `_recipientFinalizationContext` map: when the worker writes a
    // VALID disposition for a tokenId, PaymentsModule rebuilds the SDK
    // Token via `finalizeTransferToken` and overwrites the locally-
    // stored Token's sdkData + flips status to 'confirmed'.
    //
    // This is the minimum production-ready harness that closes the
    // S2 e2e loop (Bob receives instant tokens → re-spends them).
    // Bootstrap layers (Sphere) MAY override via
    // `installFinalizationWorkerRecipient()` for a full §5.5 / §6.2
    // implementation backed by Profile + OrbitDB.
    //
    // FIXME(#151): the in-memory queue + finalization context map are
    // NOT persisted across `Sphere.destroy()` and process restart.
    // Recovery on next launch requires either a manifest scan or an
    // external re-trigger (operator escape-hatch). The Profile-backed
    // FinalizationQueue (T.5.C / Wave G.7) deferred to a future wave
    // closes this gap.
    if (
      this.features.recipientUxf &&
      this.features.finalizationWorker &&
      !this.finalizationWorkerRecipient
    ) {
      const aggregatorClient = this.deps!.oracle.getAggregatorClient?.();
      if (aggregatorClient === null || aggregatorClient === undefined) {
        logger.debug(
          'Payments',
          'FinalizationWorkerRecipient auto-install skipped: oracle has no getAggregatorClient()',
        );
      } else {
        const directAddr = this.deps!.identity.directAddress;
        const recipientAddressId =
          typeof directAddr === 'string' && directAddr.length > 0
            ? computeAddressId(directAddr)
            : this.deps!.identity.chainPubkey;

        // G7 — re-hydrate the recipient context Maps from persisted
        // storage. Without this, a Sphere that crashed between enqueue
        // and finalization could not surface the contexts the
        // dispositionWriter VALID branch needs to flip local Tokens to
        // `'confirmed'`.
        //
        // The hydration is fire-and-forget so initialize() stays
        // synchronous; the recipient worker has its own retry loop and
        // is tolerant of a context Map populated mid-cycle. The hydration
        // promise is exposed via {@link awaitRecipientContextHydration}
        // for tests that need a deterministic settle point.
        if (this._recipientContextStorage !== null) {
          const ctxStorage = this._recipientContextStorage;
          this._recipientContextHydrationPromise = (async () => {
            try {
              const persistedFinalization =
                await ctxStorage.listAllFinalizationContexts(recipientAddressId);
              for (const [tokenId, ctx] of persistedFinalization) {
                if (!this._recipientFinalizationContext.has(tokenId)) {
                  this._recipientFinalizationContext.set(tokenId, ctx);
                }
              }
              const persistedRequest =
                await ctxStorage.listAllRequestContexts(recipientAddressId);
              for (const [reqId, ctx] of persistedRequest) {
                if (!this._recipientRequestContextMap.has(reqId)) {
                  // Cast: PersistedRequestContext is the JSON-safe
                  // mirror of RequestContext (`nextEntryRest` widens to
                  // Record<string, unknown> at the storage layer).
                  this._recipientRequestContextMap.set(
                    reqId,
                    ctx as unknown as RequestContext,
                  );
                }
              }
              logger.debug(
                'Payments',
                `G7: re-hydrated ${persistedFinalization.size} finalization + ${persistedRequest.size} request contexts from profile`,
              );
            } catch (err) {
              logger.warn(
                'Payments',
                `G7: failed to re-hydrate recipient context Maps from profile (continuing with empty maps): ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          })();
        }

        const built = buildDefaultFinalizationWorkerRecipient({
          addressId: recipientAddressId,
          oracle: this.deps!.oracle,
          recipientRequestContextMap: this._recipientRequestContextMap,
          recipientFinalizationContext: this._recipientFinalizationContext,
          tokens: this.tokens,
          finalizeTransferToken: (sourceToken, lastTx, stClient, trustBase) =>
            this.finalizeTransferToken(sourceToken, lastTx, stClient, trustBase),
          getStateTransitionClient: () =>
            this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          getTrustBase: () => (this.deps!.oracle as any).getTrustBase?.(),
          save: () => this.save(),
          emit: (type, data) => this.deps!.emitEvent(type, data),
          signal: this._workerAbortController.signal,
          // Round 7 (FIX 3) — share per-tokenId mutex with sender worker
          // + operator importer so all three paths serialize against the
          // same read-decide-write window.
          perTokenMutex: this._sharedPerTokenMutex,
          // G3 — pass the Profile-backed persisted FinalizationQueueStorage
          // when configured. When null, the helper falls back to the
          // in-memory shim (legacy behavior).
          finalizationQueueStorage:
            this._recipientFinalizationQueueStorage ?? undefined,
        });
        this._recipientFinalizationQueue = built.queue;
        this.finalizationWorkerRecipient = built.worker;
        // Wave 7 hygiene: retain the streak-cleanup callback so destroy()
        // can wipe the closure-local `saveFailureStreak` Map alongside
        // the other context maps.
        this._recipientSaveFailureStreakClear = built.clearSaveFailureStreak;
        this.finalizationWorkerRecipient.start();
        logger.debug(
          'Payments',
          'Default FinalizationWorkerRecipient auto-installed (recipientUxf default-on)',
        );
      }
    }

    // Round 5 (FIX 1) — auto-install the operator escape-hatch importer
    // and revalidate-cascaded runner (T.5.D). Before Round 5, no
    // production code path called `installInclusionProofImporter()` /
    // `installRevalidateCascadedRunner()`, so every wallet that
    // bootstrapped through `Sphere.init()` threw
    // `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED` on the first
    // `payments.importInclusionProof()` / `payments.revalidateCascadedChildren()`
    // call.
    //
    // The auto-installed defaults use lightweight in-memory adapters
    // (mirroring `buildDefaultFinalizationWorkerSender`'s pattern):
    //  - `InMemoryDispositionStorageAdapter` for `_invalid` / `_audit`
    //  - In-memory `MinimalManifestStorage` + a fresh `ManifestStore`
    //    bound to a fresh `Lamport` clock
    //  - Stub `queueScanner` (returns no entries) and stub
    //    `verifyProof` (returns `'NOT_AUTHENTICATED'`) so the importer
    //    fails closed on every operator-supplied proof until the
    //    bootstrap layer overrides
    //
    // Bootstrap layers (Sphere) MAY override either by calling
    // `installInclusionProofImporter()` / `installRevalidateCascadedRunner()`
    // BEFORE `initialize()` (the `!this.inclusionProofImporter` checks
    // preserve that contract) or AFTER `initialize()` (the install
    // methods replace the auto-installed instance). Production
    // override should construct an `OrbitDbDispositionStorageAdapter`
    // bound to the wallet's ProfileDatabase and an OrbitDB-backed
    // ManifestStore — see `OrbitDbDispositionStorageAdapter` JSDoc for
    // the wiring sketch.
    if (this.inclusionProofImporter === null) {
      this.inclusionProofImporter = buildDefaultInclusionProofImporter({
        emit: (type, data) => this.deps!.emitEvent(type, data),
        // Round 7 (FIX 3) — share per-tokenId mutex with finalization
        // workers so concurrent finalize + operator import on the same
        // tokenId serialize against the read-decide-write window.
        perTokenMutex: this._sharedPerTokenMutex ?? undefined,
      });
      logger.debug(
        'Payments',
        'Default InclusionProofImporter auto-installed (in-memory disposition storage)',
      );
    }
    if (this.revalidateCascadedRunner === null) {
      this.revalidateCascadedRunner = buildDefaultRevalidateCascadedRunner();
      logger.debug(
        'Payments',
        'Default RevalidateCascadedRunner auto-installed (in-memory manifest scanner)',
      );
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

    // Steelman item 3 — coalesce concurrent load() calls. Without this
    // guard, two concurrent invocations both reassign `loadedPromise`,
    // await their own promise, AND fire the post-load side effects
    // (resolveUnconfirmed scheduling, orphan sweep emission) twice —
    // producing duplicate `transfer:orphan-spending-detected` events
    // for the same orphans.
    //
    // Idempotency contract: load() is allowed to be called multiple
    // times sequentially to refresh in-memory state (each call re-
    // populates `this.tokens` from storage). What we forbid is
    // CONCURRENT invocations — those coalesce onto the in-flight
    // promise and skip the post-load side effects.
    if (this.loadedPromise !== null && !this.loaded) {
      await this.loadedPromise;
      return;
    }

    // Expose a promise that incoming transfer handlers can await to ensure
    // the token map is populated before running dedup checks.
    const doLoad = async () => {
      // Ensure token registry has loaded metadata (symbol, name, decimals)
      // before parsing tokens — otherwise tokens get fallback truncated coinId values
      await TokenRegistry.waitForReady();

      // Prime the signing-public-key cache BEFORE `loadFromStorageData`
      // runs PR #146's balance-model invariant via
      // `latestStatePredicateMatchesWallet`. Without this prime, the
      // invariant falls back to comparing predicate bytes against
      // `identity.chainPubkey` — and for wallets whose signing pubkey
      // differs from chainPubkey (e.g. derivation path or curve
      // mappings), the comparison always returns false and every
      // received token gets archived. Best-effort: a throw here only
      // means the invariant uses the chainPubkey fallback. The cache
      // is populated as a side-effect of `createSigningService()`.
      try {
        await this.createSigningService();
      } catch (err) {
        logger.debug(
          'Payments',
          `[load] signing-pubkey prime failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
        );
      }

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

      // Prime the PROXY-address cache so `isReceivedLegacyPending`'s
      // exact-match (#144 FIX F) recognizes tokens addressed to our
      // held nametags. Must run BEFORE `restoreProofPollingJobs` and
      // `recoverStrandedReceivedTokens` because both rely on
      // `isReceivedLegacyPending` / `hasFinalizationPlan` to decide
      // which tokens are eligible.
      try {
        await this.primeProxyAddressCache();
      } catch (err) {
        logger.debug('Payments', '[PROXY-CACHE] primeProxyAddressCache failed:', err);
      }

      // Restore proof-polling jobs (#144 L1). Must run AFTER the active
      // token map is populated so we can resolve persisted
      // (genesisTokenId, stateHash) pairs to in-memory `Token.id`s — and
      // BEFORE `resolveUnconfirmed` fires so newly-restored jobs are part
      // of the same accounting.
      try {
        await this.restoreProofPollingJobs();
      } catch (err) {
        logger.error('Payments', '[V6-RESTORE] Failed to restore proof-polling jobs:', err);
      }

      // Recover stranded V6-direct receives (#144 L3 migration). Walks
      // status='pending' tokens that look like received-but-not-finalized
      // targets for us, and registers proof-polling jobs by deriving the
      // requestIdHex from each token's last-tx data. Idempotent: skips
      // tokens already covered by `restoreProofPollingJobs` above.
      try {
        const recovered = await this.recoverStrandedReceivedTokens();
        if (recovered > 0) {
          logger.debug(
            'Payments',
            `[V6-RECOVER] Registered ${recovered} recovery job(s) for stranded V6-direct receives`,
          );
        }
      } catch (err) {
        logger.error('Payments', '[V6-RECOVER] Failed to scan for stranded receives:', err);
      }

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

    // Issue #97 — fire-and-forget orphan sweep. Only runs when BOTH
    // the OutboxWriter and SentLedgerWriter are installed (the sweeper
    // self-skips otherwise — see sweepOrphanSpendingTokens for the
    // rationale). Errors are caught here so a sweep failure cannot
    // break load() for downstream callers.
    if (this._outboxWriter !== null && this._sentLedgerWriter !== null) {
      void this.detectOrphanSpendingTokens()
        .then((result) => {
          if (result.skipped) {
            logger.debug('Payments', 'Orphan-spending sweep skipped on load');
            return;
          }
          if (result.orphans.length > 0) {
            logger.warn(
              'Payments',
              `Orphan-spending sweep on load detected ${result.orphans.length} ` +
                `orphan token(s) out of ${result.scannedTransferringCount} 'transferring' ` +
                `(known via OUTBOX/SENT: ${result.knownTokenIdsCount}). ` +
                `transfer:orphan-spending-detected events were emitted; operator intervention required.`,
            );
          } else {
            logger.debug(
              'Payments',
              `Orphan-spending sweep on load: clean (${result.scannedTransferringCount} 'transferring' scanned, ${result.knownTokenIdsCount} known)`,
            );
          }
        })
        .catch((err) => {
          logger.warn(
            'Payments',
            `Orphan-spending sweep on load failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
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

  /**
   * Issue #97 — Install a profile-resident {@link OutboxWriter}.
   *
   * Once installed, every send-side outbox mutation (the
   * conservative/instant dispatcher's `create`/`transition`/`write`
   * hooks AND the recovery worker's `readAllNew`/`update` callbacks)
   * dual-writes: the durable per-entry-key profile store first, then
   * the in-memory {@link _senderOutboxMap} mirror. The legacy KV-only
   * `saveToOutbox`/`removeFromOutbox` chain is preserved during the
   * transition window so consumers that haven't migrated still observe
   * the legacy snapshot.
   *
   * **When to install:** the bootstrap layer (Sphere) calls this after
   * its {@link ProfileStorageProvider} reaches the "encryption key
   * derived" state — same gate that arms
   * `buildDispositionStorageAdapter()`. Calling with `null` removes the
   * writer (used on address switch / destroy).
   *
   * **Address scope:** the writer is bound to a single address at
   * construction. The caller MUST swap the writer (install null + new)
   * when switching addresses.
   *
   * **Hydration:** the next `initialize()` call rebuilds
   * {@link _senderOutboxMap} from `writer.readAllNew()` so post-restart
   * entries are visible to the recovery worker.
   *
   * @param writer  The writer to install, or `null` to uninstall.
   */
  /**
   * Issue #97 — Install a profile-resident {@link SentLedgerWriter}.
   *
   * Once installed, every successful send terminates with a write to
   * the SENT ledger:
   *  - Conservative mode: after the outbox transitions to `'delivered'`
   *  - Instant mode: after the outbox transitions to `'delivered-instant'`
   *
   * **When to install:** alongside {@link installOutboxWriter}, in the
   * bootstrap layer (Sphere). The two writers are tightly coupled —
   * installing one without the other leaves the system in an
   * inconsistent state where outbox tombstones can erase delivery
   * records with no permanent backup. The bootstrap MUST install both
   * or neither.
   *
   * @param writer  The writer to install, or `null` to uninstall.
   */
  installSentLedgerWriter(writer: SentLedgerWriter | null): void {
    this._sentLedgerWriter = writer;
  }

  /**
   * Issue #97 — Write a SENT ledger entry derived from an outbox entry
   * that just reached terminal-success status. Called from THREE sites:
   *
   *  1. Conservative dispatcher's `transition('delivered')` hook
   *     (PaymentsModule.ts ~line 10400) — write SENT before tombstoning
   *     the outbox.
   *  2. Instant dispatcher's `write('delivered-instant')` hook
   *     (PaymentsModule.ts ~line 11400) — write SENT at first entry
   *     into the terminal-success status.
   *  3. SendingRecoveryWorker's `outbox.update` closure
   *     (PaymentsModule.ts ~line 1670) — when the worker re-publishes
   *     a stuck `'sending'` entry, it transitions to `'delivered'` /
   *     `'delivered-instant'` via this.deps.outbox.update. The
   *     dispatcher's SENT-write logic does NOT fire for this path
   *     (dispatcher hooks aren't involved) — so the update closure
   *     must call this helper to keep the SENT ledger in sync with
   *     recovered sends.
   *
   * **Return semantics** (steelman item 4 — silent-record-loss fix):
   *  - `'success'` — writer installed AND write completed. Caller MAY
   *    proceed to tombstone the outbox entry.
   *  - `'failed'`  — writer installed BUT write threw. Caller MUST
   *    NOT tombstone — the outbox entry is the only forensic record
   *    that the delivery happened. Operator triage required.
   *  - `'skipped'` — no writer installed (legacy mode). Caller
   *    proceeds with legacy KV-only behavior (tombstones the legacy
   *    outbox; no profile-resident SENT to write).
   *
   * @param entry    Outbox entry whose post-transition state to record.
   * @param opLabel  Short context tag for the error log (e.g.
   *                 'dispatchUxfConservativeSend', 'recoveryWorker').
   */
  /**
   * Parameter type is the structural subset of fields actually read
   * by this helper — see the inline destructure below. We use
   * {@link OutboxCreateInput} (= `UxfTransferOutboxEntry` minus
   * `_schemaVersion` and `lamport`) because:
   *  - `UxfTransferOutboxEntry` (from `OutboxWriter`-stamped state) is
   *    assignable to `OutboxCreateInput` structurally — the extra
   *    `_schemaVersion`/`lamport` fields are ignored.
   *  - `OutboxCreateInput` (what the instant-send outbox `write` hook
   *    receives from the orchestrator) is assignable directly, with
   *    no need for the synthetic-lamport placeholder previously
   *    required at the instant-send call site (OUTBOX-SEND-FOLLOWUPS
   *    item #7).
   * Neither caller's `lamport` is read here; the SENT ledger writer
   * stamps its own Lamport on `write()`.
   */
  private async writeSentEntryFromOutbox(
    entry: OutboxCreateInput,
    opLabel: string,
  ): Promise<'success' | 'failed' | 'skipped'> {
    if (this._sentLedgerWriter === null) return 'skipped';
    try {
      await this._sentLedgerWriter.write({
        id: entry.id,
        tokenIds: entry.tokenIds,
        bundleCid: entry.bundleCid,
        recipientTransportPubkey: entry.recipientTransportPubkey,
        recipient: entry.recipient,
        ...(typeof entry.recipientNametag === 'string'
          ? { recipientNametag: entry.recipientNametag }
          : {}),
        deliveryMethod: entry.deliveryMethod,
        mode: entry.mode,
        sentAt: Date.now(),
        // Issue #166 P2 #3 — propagate nostrEventId from OUTBOX to
        // SENT so the NostrPersistenceVerifier worker can re-query
        // the relay by event id later. Omitted when the OUTBOX entry
        // lacks the field (pre-P2 #3 entries or paths that haven't
        // wired the capture yet) so the SENT type guard's
        // "undefined OR non-empty string" rule holds.
        ...(typeof entry.nostrEventId === 'string' && entry.nostrEventId.length > 0
          ? { nostrEventId: entry.nostrEventId }
          : {}),
      });
      return 'success';
    } catch (sentErr) {
      logger.error(
        'Payments',
        `${opLabel}: SENT ledger write failed for outbox id ${entry.id} ` +
          `(bundle is already on the wire; OUTBOX entry kept live at status='delivered' as forensic record; ` +
          `operator triage required): ` +
          `${sentErr instanceof Error ? sentErr.message : String(sentErr)}`,
      );
      return 'failed';
    }
  }

  /**
   * Issue #166 P2 #2 — duplicate-bundle guard.
   *
   * Verify that none of `candidateTokenIds` is already referenced by a
   * live OUTBOX entry OR present in the SENT ledger. Throws
   * `DUPLICATE_BUNDLE_MEMBERSHIP` on the first overlap found
   * (OUTBOX checked before SENT — more diagnostic value, "still in
   * flight" beats "already delivered" for operator triage).
   *
   * **Self-skip conditions** (all silent no-ops):
   *  - `allowOverride === true` — caller explicitly opted out.
   *  - Either writer is `null` — legacy-only wallet OR the bootstrap
   *    has not yet installed both writers. The guard cannot
   *    distinguish "not in any tracked structure" from "writer
   *    unavailable," so we conservatively skip rather than reject.
   *  - `candidateTokenIds` is empty.
   *
   * **Read-failure semantics** (best-effort safety contract):
   *  - The guard catches throws from `readAllNew()` / `readAll()` and
   *    logs a `warn`, then proceeds WITHOUT the check. Rationale: the
   *    guard's job is to catch races/bugs that would silently
   *    double-include a token; a transient OrbitDB read failure
   *    should NOT block a legitimate send. The natural
   *    `'transferring'`-status filter in `SpendPlanner.buildParsedPool`
   *    is still in place as the load-bearing line of defense.
   *
   * **Cost.** O(o + s + k) where `o` is the total tokenIds across
   * OUTBOX entries, `s` is the total across SENT, and `k` is
   * `candidateTokenIds.length`. The OUTBOX/SENT reads are the
   * dominant cost; the set lookups are O(1).
   *
   * @param candidateTokenIds  Token ids the dispatcher is about to mark
   *                           as `'transferring'`.
   * @param options.opLabel    Short context tag for the throw message
   *                           (e.g. 'dispatchUxfConservativeSend').
   * @param options.allowOverride  When true, the guard is a no-op.
   *                               Wired from
   *                               `TransferRequest.allowDuplicateBundleMembership`.
   */
  private async assertNoDuplicateBundleMembership(
    candidateTokenIds: ReadonlyArray<string>,
    options: { readonly opLabel: string; readonly allowOverride: boolean },
  ): Promise<void> {
    if (options.allowOverride) return;
    if (this._outboxWriter === null || this._sentLedgerWriter === null) return;
    if (candidateTokenIds.length === 0) return;

    const candidates = new Set<string>(candidateTokenIds);

    // ── OUTBOX check ────────────────────────────────────────────────────
    let outboxEntries: ReadonlyArray<UxfTransferOutboxEntry>;
    try {
      outboxEntries = await this._outboxWriter.readAllNew();
    } catch (err) {
      logger.warn(
        'Payments',
        `${options.opLabel}: duplicate-bundle guard could not read OUTBOX (proceeding without OUTBOX check, SENT check still attempted): ${err instanceof Error ? err.message : String(err)}`,
      );
      outboxEntries = [];
    }
    for (const entry of outboxEntries) {
      for (const tid of entry.tokenIds) {
        if (candidates.has(tid)) {
          throw new SphereError(
            `${options.opLabel}: refusing to include token ${tid} in this bundle — it is already referenced by OUTBOX entry ${entry.id} (status=${entry.status}). Set TransferRequest.allowDuplicateBundleMembership=true to bypass this guard if the re-include is intentional.`,
            'DUPLICATE_BUNDLE_MEMBERSHIP',
          );
        }
      }
    }

    // ── SENT check ──────────────────────────────────────────────────────
    let sentEntries: ReadonlyArray<UxfSentLedgerEntry>;
    try {
      sentEntries = await this._sentLedgerWriter.readAll();
    } catch (err) {
      logger.warn(
        'Payments',
        `${options.opLabel}: duplicate-bundle guard could not read SENT ledger (proceeding without SENT check, OUTBOX check already passed): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    for (const entry of sentEntries) {
      for (const tid of entry.tokenIds) {
        if (candidates.has(tid)) {
          throw new SphereError(
            `${options.opLabel}: refusing to include token ${tid} in this bundle — it is already recorded as delivered in SENT ledger entry ${entry.id}. Set TransferRequest.allowDuplicateBundleMembership=true to bypass this guard if the re-include is intentional.`,
            'DUPLICATE_BUNDLE_MEMBERSHIP',
          );
        }
      }
    }
  }

  /**
   * Issue #97 — Run the orphan-spending-tx sweeper once. Detects
   * tokens with an in-flight spending transaction (status
   * `'transferring'`) that are NOT referenced by any live OUTBOX
   * entry AND NOT recorded in the SENT ledger. Such tokens indicate
   * a crash between commit (Step 1) and outbox-persist (Step 2) of
   * the canonical send flow.
   *
   * **Phase 1 (this release)** — detection + diagnostic event only.
   * Auto-recovery (re-package + re-pin + re-queue) is gated to a
   * follow-up wave because the safety surface for silent miss-routing
   * is too large to ship without dedicated tests. Operators triaging
   * a `transfer:orphan-spending-detected` event can manually re-send
   * the affected token once they confirm the recipient.
   *
   * **Auto-invocation** — this method runs once at the tail of
   * `load()` when BOTH the OutboxWriter AND the SentLedgerWriter are
   * installed (fire-and-forget; errors are logged but never break
   * load).
   *
   * **No-op return** — when either writer is missing, the sweep is
   * skipped and `skipped: true` is returned (no orphans, no events).
   *
   * **Steelman item 2** — when ANY dispatch is in flight
   * (`_dispatcherInFlightCount > 0`), the sweep also self-skips.
   * Between `selectSources` marking tokens `'transferring'` and the
   * orchestrator's `outbox.create` hook, the token legitimately
   * exists in `'transferring'` status WITHOUT yet appearing in OUTBOX
   * — a sweep in that window would produce a false-positive orphan
   * event. The gate closes the race for the public API; the auto-
   * invocation at `load()` tail is unaffected (no sends in flight
   * at boot).
   */
  async detectOrphanSpendingTokens(): Promise<OrphanSweepResult> {
    return sweepOrphanSpendingTokens({
      tokens: this.tokens.values(),
      outboxWriter: this._outboxWriter,
      sentLedgerWriter: this._sentLedgerWriter,
      emit: this.deps!.emitEvent,
      // Steelman item 2 — thread the dispatcher-in-flight counter so
      // the sweeper self-skips during in-flight sends. The auto-
      // invocation at load() tail is unaffected (count is 0 at boot);
      // public-API callers and tests now see the gate.
      dispatcherInFlightCount: this._dispatcherInFlightCount,
      // Issue #166 P2 #1 — wire the default recovery closure only
      // when the opt-in feature flag is ON. Without the flag, the
      // sweeper preserves Phase-1 detection-only behavior (no
      // `attemptRecovery` field → recovery branch in
      // sweepOrphanSpendingTokens is never taken).
      ...(this.features.orphanAutoRecovery
        ? { attemptRecovery: this.defaultOrphanRecovery.bind(this) }
        : {}),
    });
  }

  /**
   * Issue #166 P2 #1 — default orphan-spending recovery strategy.
   *
   * Restores an orphan token's status from `'transferring'` to
   * `'confirmed'` and persists the change. The token's value becomes
   * spendable again.
   *
   * **Safety contract.** Before flipping status the recovery hook
   * cross-checks the aggregator (#166 P2 #1 follow-up — OUTBOX-SEND-
   * FOLLOWUPS.md item #1). The source-token's pre-commit state hash
   * is extracted from local `sdkData` and queried via
   * {@link OracleProvider.isSpent}. The strategy:
   *  - aggregator reports state UNSPENT → spending commit never
   *    reached L3; safe to restore (the original Phase-2 happy path).
   *  - aggregator reports state SPENT → commit landed on-chain; a
   *    local restore would diverge from the aggregator's view and the
   *    next operation on the restored token would surface a confusing
   *    state-mismatch error. Escalate to manual triage.
   *  - aggregator RPC throws → fail-closed; we cannot rule out the
   *    spent case, so escalate to manual triage.
   *  - source state hash unparseable (degenerate `sdkData`) → also
   *    fail-closed; cannot verify, escalate.
   *
   * Returns `'manual'` when:
   *  - The token id is no longer in the in-memory `this.tokens`
   *    (concurrent removal — let the operator triage); OR
   *  - The token's status is no longer `'transferring'` (race
   *    between detection and recovery — the dispatcher's own
   *    Loop1-S9 restore may already have run); OR
   *  - The aggregator cross-check escalates per the cases above; OR
   *  - The persistence step (`this.save()`) throws (we left the
   *    in-memory restoration in place, but the durability
   *    guarantee is lost; operator should know).
   *
   * Throw safety: never throws — defense-in-depth converts every
   * thrown path (oracle RPC failure, `this.save()` rejection) to
   * `'manual'` rather than letting the throw propagate into the
   * sweeper (which would treat it as `'manual'` anyway — just with a
   * noisier warn-log).
   */
  private async defaultOrphanRecovery(
    finding: OrphanSpendingFinding,
  ): Promise<'recovered' | 'manual'> {
    const token = this.tokens.get(finding.tokenId);
    if (token === undefined) return 'manual';
    if (token.status !== 'transferring') return 'manual';

    // OUTBOX-SEND-FOLLOWUPS item #1: aggregator cross-check.
    //
    // The orphan's `sdkData` still holds the pre-commit serialization
    // — `commitSources` does not mutate the source token's local
    // data; the spent state shows up on-chain only. Extract the state
    // hash and ask the aggregator whether that state is already
    // recorded as spent. If yes, the spending commit DID land before
    // the crash, and restoring locally would produce a token whose
    // local state diverges from the aggregator's view.
    const sourceStateHash = extractStateHashFromSdkData(token.sdkData);
    if (sourceStateHash === '') {
      logger.warn(
        'Payments',
        `defaultOrphanRecovery: token ${token.id} has no parseable stateHash on sdkData — ` +
          `cannot cross-check aggregator; escalating to manual triage.`,
      );
      return 'manual';
    }
    let aggregatorRecordsSpent: boolean;
    try {
      aggregatorRecordsSpent = await this.deps!.oracle.isSpent(sourceStateHash);
    } catch (oracleErr) {
      // Per OracleProvider.isSpent contract, an RPC failure throws
      // (never fail-open). Treat the throw as ambiguous: we cannot
      // rule out the spent case, so escalate.
      logger.warn(
        'Payments',
        `defaultOrphanRecovery: oracle.isSpent threw for token ${token.id} ` +
          `(stateHash=${sourceStateHash}) — fail-closed to manual triage: ` +
          `${oracleErr instanceof Error ? oracleErr.message : String(oracleErr)}`,
      );
      return 'manual';
    }
    if (aggregatorRecordsSpent) {
      logger.error(
        'Payments',
        `defaultOrphanRecovery: aggregator records source state spent for token ${token.id} ` +
          `(stateHash=${sourceStateHash}) — spending commit landed on-chain, local restore ` +
          `would diverge; escalating to manual triage. Operator action: re-package the bundle ` +
          `from the post-spend recipient context, or accept the value as already-sent.`,
      );
      return 'manual';
    }

    // Apply the in-memory restoration. The Token interface has
    // `status` and `updatedAt` as mutable — same pattern used by
    // dispatchUxfConservativeSend's Loop1-S9 path (~line 11122).
    token.status = 'confirmed';
    token.updatedAt = Date.now();
    this.tokens.set(token.id, token);
    this.parsedTokenCache.delete(token.id);

    // Persist. If save() throws, the in-memory restoration sticks
    // but durability is lost — degrade to 'manual' so the operator
    // sees the detected event.
    try {
      await this.save();
    } catch (saveErr) {
      logger.warn(
        'Payments',
        `defaultOrphanRecovery: save() failed for token ${token.id} (in-memory restoration applied but not persisted): ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`,
      );
      return 'manual';
    }
    return 'recovered';
  }

  /**
   * Issue #174 — default `transitionToAudit` route for the spent-state
   * rescan worker (UXF-TRANSFER-PROTOCOL §12.3.2).
   *
   * Strategy: the off-record spend is FINAL (the L3 aggregator confirmed
   * the source state is spent), so the local token's value is gone from
   * THIS wallet's perspective regardless of who spent it. Apply the same
   * local-side cleanup that a successful local send applies:
   *
   *   1. Archive the token to history.
   *   2. Write a tombstone for `(tokenId, stateHash)` so a subsequent
   *      sync (Item #15 profile-pointer rescan, manual restore, etc.)
   *      cannot resurrect the token.
   *   3. Remove from the active in-memory map.
   *   4. Persist via `save()`.
   *
   * This is `removeToken()`'s exact contract — we delegate to it. The
   * archived record + tombstone preserves forensic context (the event
   * already fired with `tokenId / coinId / amount / suspectedSibling
   * Instance`, so operators can correlate after the fact).
   *
   * **Why not write `_audit` durable record here**: the
   * `DispositionWriter` route (§5.4 `_audit` collection) is the
   * canonical durable-record surface. Today `DispositionWriter` is
   * constructed only in tests — no production bootstrap wires it. When
   * that wiring lands, callers can override this default via
   * {@link setSpentStateRescanTransitionToAudit} to additionally
   * synthesize an AUDIT record. The local Token.status flip is
   * orthogonal: it removes the spent value from the UI regardless of
   * the durable-record path.
   *
   * **Defensive guards**:
   *  - Token concurrent-removal: `this.tokens.get(token.id)` may return
   *    `undefined` if a concurrent path (legitimate send, manual triage,
   *    another worker cycle) already removed the token. No-op in that
   *    case — the desired terminal state was reached.
   *  - Status drift: if the token's status is no longer `'confirmed'`
   *    (e.g. concurrent send moved it to `'transferring'`), defer to the
   *    other path — the send pipeline owns the transition.
   *  - `removeToken` throw: surface in a warn-log; the worker's caller
   *    contract already swallows throws from `transitionToAudit`. The
   *    `transfer:off-record-spent` event already fired so operator
   *    visibility is preserved.
   *
   * Never throws — defense-in-depth converts every error path to a
   * warn-log so the worker's outer `try/catch` in `probeOne` sees the
   * call as a "best-effort completion" rather than a failure.
   *
   * @param params - injected by the SpentStateRescanWorker. Carries the
   *   snapshot Token reference (NOT a live re-fetch), the derived
   *   `currentStateHash`, the heuristic `suspectedSiblingInstance` flag,
   *   and the wall-clock `detectedAt`. The flag is forensic only — both
   *   true and false produce the same local cleanup.
   */
  private async defaultSpentStateTransition(params: {
    readonly token: Token;
    readonly currentStateHash: string;
    readonly suspectedSiblingInstance: boolean;
    readonly detectedAt: number;
  }): Promise<void> {
    const live = this.tokens.get(params.token.id);
    if (live === undefined) {
      logger.debug(
        'Payments',
        `defaultSpentStateTransition: token ${params.token.id.slice(0, 12)}… already removed; no-op`,
      );
      return;
    }
    if (live.status !== 'confirmed') {
      logger.debug(
        'Payments',
        `defaultSpentStateTransition: token ${params.token.id.slice(0, 12)}… is now ${live.status} (not 'confirmed'); ` +
          `deferring to whatever path owns that transition`,
      );
      return;
    }
    try {
      // `removeToken` archives, tombstones, removes from the active map,
      // and persists via `save()`. All four are required for a clean
      // off-record-spend cleanup — partial application would either
      // leak forensic context (no archive) or risk re-sync resurrection
      // (no tombstone) or leave the in-memory map inconsistent.
      await this.removeToken(params.token.id);
      logger.debug(
        'Payments',
        `defaultSpentStateTransition: token ${params.token.id.slice(0, 12)}… ` +
          `(coin=${params.token.coinId.slice(0, 12)}, amount=${params.token.amount}, ` +
          `suspectedSibling=${params.suspectedSiblingInstance}) removed after off-record-spend ` +
          `(stateHash=${params.currentStateHash.slice(0, 16)}…, detectedAt=${params.detectedAt})`,
      );
    } catch (removeErr) {
      logger.warn(
        'Payments',
        `defaultSpentStateTransition: removeToken failed for ${params.token.id.slice(0, 12)}… ` +
          `(transfer:off-record-spent event already fired; operator triage recommended): ` +
          `${removeErr instanceof Error ? removeErr.message : String(removeErr)}`,
      );
      // Return early — without successful local cleanup, writing the
      // durable AUDIT record below could leave the wallet in a hybrid
      // state (active-pool token + `_audit` record for the same
      // tokenId). The next rescan cycle will retry both paths once
      // the underlying issue clears.
      return;
    }
    // Issue #174 (PR #B) — durable AUDIT record. Best-effort: the
    // writer is optional (`_spentStateAuditWriter === null` when the
    // bootstrap layer hasn't installed it, e.g. legacy wallets, no
    // OrbitDb backing). When wired, synthesize a `DispositionRecord`
    // with `disposition='AUDIT'`, `reason='off-record-spend'`,
    // `auditStatus='audit-off-record-spend'`, and route through
    // `dispositionWriter.write()` — same code path the disposition
    // engine uses for received off-record-spent bundles (§5.3 [E]).
    //
    // Synthesized fields:
    //   - `tokenId`: SDK genesis tokenId from `sdkData`. Empty
    //     string when unparseable → routes to the `_audit-orphan`
    //     keyspace per `auditKeyFor`.
    //   - `observedTokenContentHash`: SHA-256 of `sdkData` —
    //     64-char hex, satisfies `assertCanonicalContentHash`.
    //     Stable: two probes of the same token in the same state
    //     produce the same hash, so `mergeAuditEntry` correctly
    //     dedups.
    //   - `bundleCid`: synthetic `local-rescan-{addr}-{detectedAt}`
    //     marker since no incoming bundle drove this detection.
    //     Stamped in `bundleCidsObserved`.
    //   - `senderTransportPubkey`: our own `chainPubkey` (the entity
    //     that observed the off-record spend is THIS device).
    //   - `auditStatus`: `'audit-off-record-spend'` — the canonical
    //     initial state for §5.3 [E].
    //
    // Never throws — defense-in-depth converts every error path
    // (writer not wired, identity missing, write rejection) to a
    // warn-log. The event already fired; the local cleanup
    // succeeded; the durable record is observational forensics.
    // Steelman H3 (PR #179 review): lazy field read — the writer is
    // looked up AT PROBE TIME, not at closure-bind time. This means
    // the bootstrap layer (Sphere) can install the writer BEFORE OR
    // AFTER `payments.initialize()` (which starts the rescan worker);
    // the closure observes whatever value is in the field when the
    // probe actually fires. With the default `intervalMs = 5 min`,
    // any reasonable bootstrap order completes well before the first
    // probe. If the writer is null at probe time (e.g. legacy
    // wallets without an OrbitDb adapter, or a race between bootstrap
    // and an aggressively-tuned `intervalMs` in tests), we degrade
    // gracefully: local cleanup already happened above; only the
    // durable forensic record is skipped.
    const writer = this._spentStateAuditWriter;
    if (writer === null) return;
    const identity = this.deps?.identity;
    if (identity === undefined) {
      logger.warn(
        'Payments',
        `defaultSpentStateTransition: identity missing — skipping AUDIT record for ${params.token.id.slice(0, 12)}…`,
      );
      return;
    }
    const directAddr =
      typeof identity.directAddress === 'string' && identity.directAddress.length > 0
        ? identity.directAddress
        : null;
    const addr = directAddr !== null ? computeAddressId(directAddr) : identity.chainPubkey;
    try {
      const sdkTokenId =
        extractTokenIdFromSdkData(params.token.sdkData) ?? '';
      const sdkDataBytes = new TextEncoder().encode(params.token.sdkData ?? '');
      const digest = sha256(sdkDataBytes);
      let observedTokenContentHash = '';
      for (const b of digest) observedTokenContentHash += b.toString(16).padStart(2, '0');
      const auditRecord: DispositionRecord = {
        disposition: 'AUDIT',
        tokenId: sdkTokenId,
        observedTokenContentHash: observedTokenContentHash as DispositionRecord['observedTokenContentHash'],
        // Steelman H1 (PR #179 review): include the local token id so
        // two distinct tokens probed in the SAME millisecond produce
        // distinct synthetic markers in their respective
        // `bundleCidsObserved` lists. Storage key is keyed by
        // (addr, tokenId, observedTokenContentHash) so distinct keys
        // were guaranteed already; this fix is for forensic fidelity
        // when an operator replays the bundleCidsObserved accumulator.
        bundleCid: `local-rescan-${addr}-${params.token.id.slice(0, 12)}-${params.detectedAt}`,
        senderTransportPubkey: identity.chainPubkey,
        auditStatus: 'audit-off-record-spend',
        reason: 'off-record-spend',
      };
      await writer.write(addr, auditRecord);
      logger.debug(
        'Payments',
        `defaultSpentStateTransition: AUDIT record written for ${params.token.id.slice(0, 12)}… ` +
          `(addr=${addr.slice(0, 16)}…, tokenId=${sdkTokenId.slice(0, 16)}…, ` +
          `observedTokenContentHash=${observedTokenContentHash.slice(0, 16)}…)`,
      );
    } catch (writerErr) {
      logger.warn(
        'Payments',
        `defaultSpentStateTransition: AUDIT record write failed for ${params.token.id.slice(0, 12)}… ` +
          `(local cleanup already applied; durable record absent until next rescan or operator replay): ` +
          `${writerErr instanceof Error ? writerErr.message : String(writerErr)}`,
      );
    }
  }

  installOutboxWriter(writer: OutboxWriter | null): void {
    this._outboxWriter = writer;
    if (writer !== null) {
      // Capture the writer reference in the closure so the hydration's
      // .then() callback can detect that the writer has been replaced
      // (or uninstalled via installOutboxWriter(null) — e.g. on
      // Sphere.destroy). If `this._outboxWriter !== writer` when the
      // callback fires, bail without mutating the mirror map — that
      // ensures a destroyed PaymentsModule never gets its cleared
      // `_senderOutboxMap` repopulated by a late hydration. Closes
      // steelman item 5 (hydration promise leaks past destroy).
      const writerRef = writer;
      // Fire-and-forget hydration of the in-memory mirror. The
      // FinalizationWorkerSender (Phase 9.6.D) reads via `readOne(id)`
      // against `_senderOutboxMap`, so post-restart instant-mode
      // entries become visible to the worker after this resolves.
      // Errors are warned-only: the recovery worker reads directly
      // from the writer (post-#97), so a failed hydration degrades to
      // "FinalizationWorkerSender takes a moment longer to see
      // post-restart entries" — never a data-loss path.
      void writerRef
        .readAllNew()
        .then((entries) => {
          // Steelman item 5 — writer-identity guard. The hydration
          // Promise can resolve AFTER destroy()/uninstall has cleared
          // `_outboxWriter` and `_senderOutboxMap`. Without this check,
          // the callback would repopulate the cleared map.
          if (this._outboxWriter !== writerRef) {
            logger.debug(
              'Payments',
              'installOutboxWriter: hydration aborted (writer replaced or uninstalled during readAllNew)',
            );
            return;
          }
          // Issue #97 (steelman W2) — race protection. The hydration
          // is fire-and-forget; a concurrent send may have already
          // mutated the mirror to a newer state by the time these
          // snapshot entries arrive. Only overwrite when the snapshot
          // entry has a HIGHER lamport than what's currently in the
          // mirror — otherwise we'd silently clobber post-restart
          // writes that the dispatcher just made.
          let hydratedCount = 0;
          let skippedCount = 0;
          for (const e of entries) {
            // Re-check writer identity inside the loop — if another
            // installOutboxWriter(null) racing with this loop fires,
            // bail mid-loop rather than partial-populate.
            if (this._outboxWriter !== writerRef) return;
            const existing = this._senderOutboxMap.get(e.id);
            if (existing !== undefined && existing.lamport >= e.lamport) {
              skippedCount += 1;
              continue;
            }
            this._senderOutboxMap.set(e.id, e);
            hydratedCount += 1;
          }
          logger.debug(
            'Payments',
            `installOutboxWriter: hydrated ${hydratedCount} outbox entries (${skippedCount} skipped — concurrent writer already advanced lamport)`,
          );
        })
        .catch((err) => {
          // Same identity guard — if the writer is gone, suppress the
          // warning to avoid spam during destroy().
          if (this._outboxWriter !== writerRef) return;
          logger.warn(
            'Payments',
            `installOutboxWriter: failed to hydrate _senderOutboxMap from writer (recovery worker still reads via writer.readAllNew): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
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
  /** @internal — auto-installed or set by `installSentReconciliationWorker()`. Issue #166 P2 #4. */
  private sentReconciliationWorker: SentReconciliationWorker | null = null;
  /** @internal — auto-installed or set by `installNostrPersistenceVerifier()`. Issue #166 P2 #3. */
  private nostrPersistenceVerifier: NostrPersistenceVerifier | null = null;
  /** @internal — auto-installed or set by `installSpentStateRescanWorker()`. Issue #174. */
  private spentStateRescanWorker: SpentStateRescanWorker | null = null;
  /**
   * @internal — optional override for the spent-state rescan worker's
   * `transitionToAudit` closure. When set via
   * {@link setSpentStateRescanTransitionToAudit}, the override REPLACES
   * the default {@link defaultSpentStateTransition} closure that the
   * auto-install wires in {@link initialize}. The override exists so
   * future bootstrap-layer work can route detection through a
   * production-wired `DispositionWriter.write()` (synthesized AUDIT
   * record per §5.3 [E] / §5.4 — once `DispositionWriter` is
   * constructed in production; today it lives only in tests).
   *
   * Pass `null` (or never call the setter) → the default closure
   * runs: archive + tombstone + remove from active map via
   * {@link removeToken}, mirroring `defaultOrphanRecovery`'s pattern.
   * The token's value leaves the spendable pool and the tombstone
   * prevents re-sync resurrection.
   *
   * Issue #174.
   */
  private _spentStateRescanTransitionToAudit: TransitionToAuditFn | null = null;
  /**
   * @internal — installed by the bootstrap layer (Sphere) via
   * {@link installSpentStateAuditWriter}. When non-null, the default
   * spent-state-rescan closure ({@link defaultSpentStateTransition})
   * synthesizes an AUDIT {@link DispositionRecord} (reason
   * `'off-record-spend'`, §5.3 [E] / §5.4) and calls `writer.write()`
   * AFTER the local `removeToken()` cleanup. When null, the closure
   * does the local cleanup only.
   *
   * The writer's AUDIT path (`writeAudit`) touches only the per-entry
   * `_audit` collection — the `manifestStore` field on the writer is
   * unused for this consumer. Sphere constructs a writer whose
   * `manifestStore` is a throw-on-access stub; if a non-AUDIT
   * disposition is ever routed through this writer (it shouldn't), the
   * stub fires loudly.
   *
   * Issue #174 / PR #B (DispositionWriter wiring).
   */
  private _spentStateAuditWriter: DispositionWriter | null = null;
  /** @internal — auto-installed when `features.tombstoneGcWorker` is on.
   *  OUTBOX-SEND-FOLLOWUPS item #4. */
  private tombstoneGcWorker: TombstoneGcWorker | null = null;
  /** @internal — auto-installed or set by `installFinalizationWorkerSender()`. Phase 9.6.D. */
  private finalizationWorkerSender: FinalizationWorkerSender | null = null;
  /**
   * @internal — auto-installed FinalizationWorkerRecipient. Task #151.
   *
   * Auto-instantiated in `initialize()` when `recipientUxf` is on AND
   * `finalizationWorker` is on AND no consumer-installed worker is
   * present. The default harness uses lightweight in-memory adapters
   * (FinalizationQueue, manifestCas, tombstones, pool, queue) plus a
   * stub revaluateHooks that always says VALID and a custom
   * dispositionWriter that flips the local Token's status from
   * `'pending'` to `'confirmed'` once the proof is attached.
   *
   * The default harness IS NOT a complete §5.5 / §6.2 implementation:
   *  - revaluateHooks short-circuits the [B]/[D]/[E] re-run.
   *  - cascadeWalker is a no-op (no children scan, no NFT routing).
   *  - manifestCas/tombstones/pool are in-memory with no replication.
   *
   * It IS sufficient to drive the end-to-end e2e instant-mode receive
   * cycle: Bob's pending tokens transition to confirmed when the
   * aggregator returns proofs, unblocking the re-spend phase.
   *
   * Bootstrap layers (Sphere) MAY override this default by calling
   * `installFinalizationWorkerRecipient()` BEFORE `initialize()` (the
   * `!this.finalizationWorkerRecipient` check preserves that contract)
   * or AFTER `initialize()` (the install method stops the previous
   * worker and starts the new one).
   *
   * TODO(#151-followup): persist the recipient queue + finalization
   * context across restarts via ProfileTokenStorageProvider's per-
   * entry-key layout. Today, on `Sphere.destroy()` and process restart,
   * pending tokens stay in `_recipientFinalizationContext` only until
   * the process exits; recovery requires a manifest scan or external
   * re-trigger.
   *
   * See `tests/unit/payments/transfer/finalization-worker-recipient-fixtures.ts`
   * for the full production surface this worker requires.
   */
  private finalizationWorkerRecipient: FinalizationWorkerRecipient | null = null;
  /**
   * @internal — Task #169. AbortController whose signal is wired into
   * the sender (and future recipient) finalization workers' `signal`
   * option AND their `sleep` adapters. Aborted in `destroy()` BEFORE
   * awaiting `worker.stop()` so in-flight `runFinalizationCycle`
   * invocations + their pending `sleep(...)` timers terminate
   * deterministically rather than running orphaned to completion.
   *
   * The controller is recreated on every `initialize()` — once
   * aborted, an AbortSignal cannot be reset, so a destroy()/initialize()
   * cycle needs a fresh controller for the next worker generation.
   */
  private _workerAbortController: AbortController | null = null;

  /**
   * In-memory outbox for the sender-side finalization worker.
   * Stores `UxfTransferOutboxEntry` objects by outbox id.
   * The instant-sender writes here at `delivered-instant` stage;
   * the worker reads + updates via the injected `FinalizationOutboxWriter`.
   *
   * When a profile-resident {@link _outboxWriter} is installed via
   * {@link installOutboxWriter}, this map functions as a write-through
   * cache on top of the durable per-entry-key store — the writer is the
   * source of truth across restarts; this map is hydrated from it in
   * `initialize()` and updated in lock-step on every dispatcher hook
   * call.
   *
   * @internal
   */
  private readonly _senderOutboxMap: Map<string, UxfTransferOutboxEntry> = new Map();

  /**
   * Issue #97 — Profile-resident outbox writer, when wired by the
   * bootstrap layer. The writer persists per-entry-key UXF outbox
   * entries under `${addressId}.outbox.${id}` in the profile's OrbitDB
   * key-value store, IPFS-synced. Survives total local profile loss
   * (recovered on next sync from the aggregator pointer / IPNS
   * snapshot).
   *
   * When `null`, the dispatcher hooks fall back to the legacy KV-only
   * outbox path (`saveToOutbox`/`removeFromOutbox`) and the in-memory
   * `_senderOutboxMap`. When non-null, every dispatcher hook performs
   * a dual-write: durable profile write first, then the in-memory map
   * mirror is updated to match.
   *
   * Lifecycle: installed by the bootstrap layer (Sphere) AFTER the
   * profile encryption key is derived but BEFORE `initialize()` so the
   * Lamport rehydration runs against the live writer. Address-switch
   * MUST call `installOutboxWriter(null)` then `installOutboxWriter(new)`
   * with the new address scope.
   *
   * @internal
   */
  private _outboxWriter: OutboxWriter | null = null;

  /**
   * Issue #97 — Profile-resident SENT ledger writer, when wired by the
   * bootstrap layer. Companion to {@link _outboxWriter}.
   *
   * Written after the outbox transitions to a terminal-success status:
   *  - Conservative mode → after `'delivered'`
   *  - Instant mode → after `'delivered-instant'`
   *
   * The SENT ledger is the permanent counterpart to the operational
   * outbox: outbox entries are tombstoned after delivery, SENT entries
   * persist forever. Consulted by the crash-recovery sweeper (Issue
   * #97 step 6) and the duplicate-bundle guard (step 7).
   *
   * When `null`, SENT records are NOT written — falls back to the
   * legacy in-memory `addToHistory()` path. The crash-recovery sweeper
   * is a no-op without it.
   *
   * @internal
   */
  private _sentLedgerWriter: SentLedgerWriter | null = null;

  /**
   * Issue #97 (steelman item 2) — dispatcher-in-flight reference
   * counter. Incremented at the entry of each `dispatchUxf*Send` /
   * `dispatchTxfSend` call, decremented in the `finally` of each.
   * The orphan-spending sweeper reads this counter: when it is
   * non-zero, the sweep self-skips (returns `skipped: true`) because
   * a send is mid-flight — tokens are legitimately in `'transferring'`
   * status WITHOUT yet appearing in OUTBOX (the orchestrator's
   * `outbox.create` runs AFTER `commitSources` which can take
   * seconds). Without this gate, the public-API sweeper races with
   * in-flight sends and emits false-positive
   * `transfer:orphan-spending-detected` events.
   *
   * @internal
   */
  private _dispatcherInFlightCount: number = 0;

  /**
   * Per-requestId context map for the sender-side finalization worker resolver.
   * Populated by `dispatchUxfInstantSend`'s `commitSources` callback
   * with `(requestIdHex → RequestContext)`.
   *
   * @internal
   */
  private readonly _senderRequestContextMap: Map<string, RequestContext> = new Map();

  /**
   * Task #151 — Per-requestId context map for the recipient-side
   * finalization worker resolver. Populated by the default processToken
   * closure on instant-mode receive (where the bundle's last tx has
   * `inclusionProof: null`). Mirrors {@link _senderRequestContextMap}
   * but keyed on the bundle's commitmentRequestId.
   *
   * @internal
   */
  private readonly _recipientRequestContextMap: Map<string, RequestContext> = new Map();

  /**
   * Task #151 — Per-tokenId finalization context for the recipient
   * worker. When processToken sees an instant-mode token (last tx has
   * `inclusionProof: null`), it stores the source-token JSON, the last
   * transferred-tx JSON, and the recipient predicate / state so that
   * once the proof lands the worker can rebuild a fully-finalized SDK
   * Token via {@link finalizeTransferToken} and overwrite the locally-
   * stored Token with `status: 'confirmed'` so subsequent re-spend
   * paths can pick it up.
   *
   * **In-memory only** — TODO(#151-followup): persist across restarts
   * by wiring through ProfileTokenStorageProvider's per-entry-key layout
   * so a wallet that crashes mid-finalization recovers the queue +
   * context on next launch.
   *
   * @internal
   */
  private readonly _recipientFinalizationContext: Map<
    string,
    RecipientFinalizationContext
  > = new Map();

  /**
   * Task #151 — In-memory FinalizationQueue used by the auto-installed
   * recipient worker. Wired through `buildDefaultFinalizationWorkerRecipient`
   * to a Map-backed storage adapter. See `_recipientFinalizationContext`
   * for the persistence caveat (in-memory only).
   *
   * @internal
   */
  private _recipientFinalizationQueue: FinalizationQueue | null = null;

  /**
   * Wave 7 hygiene — callback returned by
   * `buildDefaultFinalizationWorkerRecipient` that clears the closure-
   * local `saveFailureStreak` Map. Invoked from {@link destroy} so the
   * streak doesn't outlive the recipient finalization context.
   *
   * @internal
   */
  private _recipientSaveFailureStreakClear: (() => void) | null = null;

  /**
   * Round 7 (FIX 3) — shared per-tokenId mutex for all paths that touch
   * the same `tokenId` within this PaymentsModule instance: the
   * sender-side FinalizationWorkerSender, the recipient-side
   * FinalizationWorkerRecipient, AND the operator escape-hatch
   * InclusionProofImporter. Sharing one mutex per instance ensures
   * that a concurrent finalize and operator import on the same tokenId
   * serialize against the read-decide-write window, matching the
   * `ImportInclusionProofOptions.perTokenMutex` JSDoc contract that
   * callers SHOULD share with the workers.
   *
   * Recreated in `initialize()` (per the same lifecycle as
   * `_workerAbortController`) and cleared in {@link destroy} so a
   * destroy()/initialize() cycle starts with a fresh mutex.
   *
   * @internal
   */
  private _sharedPerTokenMutex: PerTokenMutex | null = null;

  /**
   * G3 — persisted FinalizationQueueStorage for the recipient
   * finalization worker. Set by Sphere bootstrap before
   * {@link initialize} when a Profile-backed storage stack is available.
   * `buildDefaultFinalizationWorkerRecipient` consumes this directly;
   * when null, it falls back to the legacy in-memory `Map<string,string>`
   * shim (loss-prone across Sphere.destroy() / restart).
   *
   * @internal
   */
  private _recipientFinalizationQueueStorage:
    | import('./transfer/finalization-queue').FinalizationQueueStorage
    | null = null;

  /**
   * G7 — persisted recipient-context CRUD adapter for the in-memory
   * `_recipientRequestContextMap` and `_recipientFinalizationContext`
   * Maps. Set by Sphere bootstrap when a Profile-backed storage stack
   * is available; consumed in {@link initialize} to re-hydrate the
   * Maps before the recipient worker starts and in the processToken
   * closure to mirror every in-memory write to disk.
   *
   * @internal
   */
  private _recipientContextStorage:
    | import('../../profile/finalization-queue-storage-adapter').OrbitDbRecipientContextStorageAdapter
    | import('../../profile/finalization-queue-storage-adapter').InMemoryRecipientContextStorageAdapter
    | null = null;

  /**
   * G7 — Promise tracking the in-flight re-hydration of the recipient
   * context Maps from persisted storage. Set by {@link initialize}'s
   * auto-install path when a `_recipientContextStorage` is configured;
   * `undefined` otherwise. Exposed via
   * {@link awaitRecipientContextHydration} for tests that need a
   * deterministic settle point.
   *
   * @internal
   */
  private _recipientContextHydrationPromise: Promise<void> | undefined =
    undefined;

  /**
   * G7 — Test/diagnostic hook: await the in-flight recipient-context
   * hydration. Returns a resolved promise when no hydration is in
   * flight. Production code paths SHOULD NOT need to await this —
   * the recipient worker is tolerant of a Map populated mid-cycle —
   * but tests that assert post-hydration state need a settle point.
   */
  async awaitRecipientContextHydration(): Promise<void> {
    if (this._recipientContextHydrationPromise === undefined) return;
    await this._recipientContextHydrationPromise;
  }

  /**
   * G3 + G7 — Install Profile-backed persisted storage for the
   * recipient-side cross-restart safety net. Sphere bootstrap calls
   * this after `setIdentity()` (so the encryption key is derived) but
   * BEFORE `initialize()` (so the auto-installed recipient worker picks
   * up the persisted FinalizationQueueStorage and the in-memory Maps
   * are re-hydrated from the persisted contexts).
   *
   * Idempotent. Tests pass an in-memory adapter; production wires
   * `OrbitDbFinalizationQueueStorageAdapter` and
   * `OrbitDbRecipientContextStorageAdapter` against the wallet's
   * ProfileDatabase.
   */
  configureRecipientPersistedStorage(opts: {
    readonly finalizationQueueStorage?: import('./transfer/finalization-queue').FinalizationQueueStorage;
    readonly recipientContextStorage?:
      | import('../../profile/finalization-queue-storage-adapter').OrbitDbRecipientContextStorageAdapter
      | import('../../profile/finalization-queue-storage-adapter').InMemoryRecipientContextStorageAdapter;
  }): void {
    if (opts.finalizationQueueStorage !== undefined) {
      this._recipientFinalizationQueueStorage = opts.finalizationQueueStorage;
    }
    if (opts.recipientContextStorage !== undefined) {
      this._recipientContextStorage = opts.recipientContextStorage;
    }
  }

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
   * Round 7 (FIX 1) / Round 8 (FIX 1) — Reconfigure the auto-installed
   * {@link InclusionProofImporter} with a production-wired
   * `dispositionStorage` adapter (typically
   * {@link OrbitDbDispositionStorageAdapter} bound to the wallet's
   * ProfileDatabase) AND the trust-base-aware proof verifier +
   * graft/override callbacks. Idempotent: rebuilds and replaces the
   * current importer using the same shared per-tokenId mutex
   * (`_sharedPerTokenMutex`) so the new importer continues to serialize
   * with the finalization workers.
   *
   * Bootstrap layers (Sphere) call this after `initialize()` once the
   * profile stack + oracle are ready to hand them an OrbitDb-backed
   * adapter and a wired `verifyProof`. When called BEFORE
   * `initialize()`, it throws `NOT_INITIALIZED` (the importer needs
   * `this.deps` to wire `emit`).
   *
   * Round 8 (FIX 1) — `verifyProof` is now wired through to
   * `oracle.verifyInclusionProof()` via the bootstrap layer. The
   * importer's case 8 / 9 short-circuits run against a real
   * trust-base-aware verifier instead of the Round 7 fail-closed stub.
   * `graftCallback` / `overrideCallback` accept production callbacks
   * (the bootstrap layer wires them when the OrbitDB pool/manifest/
   * tombstone/queue adapters are available); when omitted, the
   * defaults remain no-ops (unreachable in the default harness because
   * the stub `queueScanner` returns no entries — bootstrap layers that
   * wire a real `queueScanner` alongside these callbacks close the
   * remaining case 3 / 5 / 6 gap).
   */
  configureOperatorEscapeHatchStorage(
    dispositionStorage: import('../../profile/disposition-writer').DispositionPerEntryStorage,
    options?: {
      readonly verifyProof?: import('./transfer/import-inclusion-proof').ProofVerifier;
      readonly graftCallback?: import('./transfer/import-inclusion-proof').ImportProofGraftCallback;
      readonly overrideCallback?: import('./transfer/import-inclusion-proof').ImportProofOverrideCallback;
    },
  ): void {
    this.ensureInitialized();
    this.inclusionProofImporter = buildDefaultInclusionProofImporter({
      emit: (type, data) => this.deps!.emitEvent(type, data),
      perTokenMutex: this._sharedPerTokenMutex ?? undefined,
      dispositionStorage,
      ...(options?.verifyProof !== undefined ? { verifyProof: options.verifyProof } : {}),
      ...(options?.graftCallback !== undefined ? { graftCallback: options.graftCallback } : {}),
      ...(options?.overrideCallback !== undefined ? { overrideCallback: options.overrideCallback } : {}),
    });
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
   * Issue #166 P2 #4 — install the SENT-write reconciliation worker.
   * Idempotent: a second call stops the previous worker (await its
   * in-flight scan) and swaps in the new instance. If
   * `features.sentReconciliationWorker` is `true`, the next
   * `initialize()` call starts the new worker; if the module is
   * already initialized, the worker is started immediately.
   *
   * The bootstrap layer (Sphere) ordinarily does NOT need to call this
   * — the auto-install path in `initialize()` already wires a default
   * worker with closures over the production writers. This hook exists
   * for tests that need a fully-mocked worker AND for future bootstrap
   * layers that want to inject a custom failure-event consumer.
   *
   * **No-op when `features.sentReconciliationWorker === false`** —
   * installing is cheap (no scan loop runs until `start()`); the gate
   * is the flag.
   */
  installSentReconciliationWorker(worker: SentReconciliationWorker): void {
    // Stop the previous worker without blocking the install. We
    // intentionally do not await here — callers may be hot-swapping
    // workers under test, and the worker's stop() is documented as
    // "best-effort, never throws". Errors are swallowed.
    if (this.sentReconciliationWorker !== null) {
      void this.sentReconciliationWorker.stop().catch(() => undefined);
    }
    this.sentReconciliationWorker = worker;
    if (this.deps !== null && this.features.sentReconciliationWorker) {
      worker.start();
    }
  }

  /**
   * Issue #166 P2 #3 — install the Nostr persistence verification
   * worker. Idempotent: a second call stops the previous worker
   * (await its in-flight scan) and swaps in the new instance. If
   * `features.nostrPersistenceVerifier` is `true`, the next
   * `initialize()` call starts the new worker; if the module is
   * already initialized, the worker is started immediately.
   *
   * **No-op when `features.nostrPersistenceVerifier === false`** —
   * installing is cheap (no scan loop runs until `start()`); the gate
   * is the flag.
   */
  installNostrPersistenceVerifier(worker: NostrPersistenceVerifier): void {
    if (this.nostrPersistenceVerifier !== null) {
      void this.nostrPersistenceVerifier.stop().catch(() => undefined);
    }
    this.nostrPersistenceVerifier = worker;
    if (this.deps !== null && this.features.nostrPersistenceVerifier) {
      worker.start();
    }
  }

  /**
   * Issue #174 — install the per-token spent-state rescan worker.
   * Idempotent: a second call stops the previous worker (await its
   * in-flight scan) and swaps in the new instance. If
   * `features.spentStateRescan` is `true`, the next `initialize()`
   * call starts the new worker; if the module is already initialized,
   * the worker is started immediately.
   *
   * **No-op when `features.spentStateRescan === false`** — installing
   * is cheap (no scan loop runs until `start()`); the gate is the flag.
   */
  installSpentStateRescanWorker(worker: SpentStateRescanWorker): void {
    if (this.spentStateRescanWorker !== null) {
      void this.spentStateRescanWorker.stop().catch(() => undefined);
    }
    this.spentStateRescanWorker = worker;
    if (this.deps !== null && this.features.spentStateRescan) {
      worker.start();
    }
  }

  /**
   * Issue #174 — set the closure invoked when the spent-state rescan
   * worker detects an off-record spend. When unset (or reset via
   * `null`), the auto-installed worker uses
   * {@link defaultSpentStateTransition} — `removeToken()` so the spent
   * token is archived, tombstoned, and removed from the active map.
   *
   * Override use cases:
   *   - Future bootstrap-layer wiring of `DispositionWriter` (today
   *     constructed only in tests) — the override can ALSO synthesize
   *     a durable `_audit` record per §5.3 [E] / §5.4 in addition to
   *     calling `removeToken()` for the local-state cleanup. The two
   *     paths are orthogonal.
   *   - Tests / operator escape-hatch — the override can be an
   *     explicit no-op (`async () => undefined`) to FORCE detect-only
   *     mode (event emission only, no local Token.status flip).
   *
   * **Important:** passing `null` does NOT give you detect-only mode
   * — it RESTORES the default closure (`removeToken`). To force
   * detect-only behavior, pass an explicit no-op closure.
   *
   * The closure takes effect on the NEXT `initialize()` call when the
   * worker is auto-constructed. To replace the route on a running
   * worker, install a fresh worker via
   * {@link installSpentStateRescanWorker}.
   */
  setSpentStateRescanTransitionToAudit(
    transition: TransitionToAuditFn | null,
  ): void {
    this._spentStateRescanTransitionToAudit = transition;
  }

  /**
   * Issue #174 — install the {@link DispositionWriter} used by the
   * spent-state rescan worker's default closure to synthesize a
   * durable `_audit` record (reason `'off-record-spend'`, §5.3 [E] /
   * §5.4) ALONGSIDE the local `removeToken()` cleanup.
   *
   * The bootstrap layer (Sphere) builds the writer from the wallet's
   * OrbitDb-backed `OrbitDbDispositionStorageAdapter` + a throw-on-
   * access stub `ManifestStore` (the AUDIT path doesn't touch
   * `manifestStore`; the stub fails loudly if a non-AUDIT disposition
   * is ever routed through this writer). Tests inject a fully-mocked
   * writer.
   *
   * Idempotent: a second call replaces the previous writer.
   *
   * Passing `null` removes the writer — the default closure reverts to
   * local-cleanup-only behavior (the same as not having a wired
   * `DispositionWriter` at all). This is the right surface for a
   * wallet teardown / hot-swap.
   *
   * **No-op when the spent-state-rescan worker isn't running** (i.e.
   * `features.spentStateRescan === false`) — the writer is just
   * stashed; nothing invokes it until the next probe fires.
   */
  installSpentStateAuditWriter(writer: DispositionWriter | null): void {
    this._spentStateAuditWriter = writer;
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
   * Task #151 — install the recipient-side finalization worker.
   *
   * Idempotent: a second call stops the previous worker (fire-and-
   * forget) and swaps in the new instance. If the module is already
   * initialized AND `features.recipientUxf` is true, the new worker
   * is started immediately.
   *
   * The recipient worker has NO auto-install path today because the
   * default `IngestWorkerPool.processToken` closure (lines ~1422-1662)
   * does NOT enqueue pending tokens into a `FinalizationQueue`, and
   * the worker requires (a) the per-address FinalizationQueue store,
   * (b) dispositionWriter (T.3.C), (c) revaluateHooks
   * (RevaluateHooksProvider), (d) cascadeWalker, (e) per-tokenId
   * mutex, (f) manifest CAS / tombstones / pool adapters — all of
   * which are bootstrap-layer concerns (Sphere builds them with the
   * full Profile + OrbitDB stack). When the bootstrap layer ships
   * the harness, callers wire it via this method; the worker's
   * AbortSignal can be sourced from `getWorkerAbortSignal()` below.
   */
  installFinalizationWorkerRecipient(worker: FinalizationWorkerRecipient): void {
    if (this.finalizationWorkerRecipient !== null) {
      void this.finalizationWorkerRecipient.stop().catch(() => undefined);
    }
    this.finalizationWorkerRecipient = worker;
    if (this.deps !== null && this.features.recipientUxf) {
      worker.start();
    }
  }

  /**
   * Task #169 — Expose the per-initialize worker AbortSignal so the
   * bootstrap layer's recipient-worker harness can plumb it into
   * the constructed `FinalizationWorkerRecipient`. Returns `undefined`
   * when the module has not yet been initialized.
   *
   * The signal is aborted in `destroy()` BEFORE awaiting `worker.stop()`
   * so in-flight `runFinalizationCycle` invocations + their pending
   * `sleep(...)` timers terminate deterministically.
   */
  getWorkerAbortSignal(): AbortSignal | undefined {
    return this._workerAbortController?.signal;
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
    // Round 3 — lowercase-normalize the tokenId at the public entry,
    // BEFORE the importer's strict-lowercase shape regex would otherwise
    // reject uppercase input. SDK callers (operator scripts, CLI tools,
    // wallet UIs that paste raw hex from the state-transition SDK) often
    // produce uppercase or mixed-case tokenIds; rejecting them at the
    // public surface would force every caller to remember to normalize.
    // Round 1 doc claimed "Wallet code lowercases SDK tokenIds before
    // passing them to the importer" — this is the wrapper-level
    // normalization that delivers on that claim.
    //
    // The importer's internal lowercase-normalize (defense-in-depth at
    // `_importInclusionProofUnderMutex`) remains in place for any code
    // path that bypasses this wrapper.
    const normalizedTokenId =
      typeof tokenId === 'string' ? tokenId.toLowerCase() : tokenId;
    return this.inclusionProofImporter.importInclusionProof(
      addr,
      normalizedTokenId,
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
    // Round 5 (FIX 5) — lowercase-normalize the parentTokenId at the
    // public entry, mirroring the Round 3 `importInclusionProof` fix.
    // Operator-supplied uppercase tokenIds would otherwise silently find
    // zero children in the prefix-scan path, masking real cascades.
    // Manifest entries are written under canonical lowercase keys (see
    // FIX 4); without this normalization the runner queries the wrong
    // keyspace and the operator sees a misleadingly-clean result.
    const normalizedParentTokenId =
      typeof parentTokenId === 'string'
        ? parentTokenId.toLowerCase()
        : parentTokenId;
    return this.revalidateCascadedRunner.run(addr, normalizedParentTokenId);
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
    // #144 FIX F: clear PROXY-address cache (per-address state).
    this.proxyAddressCache.clear();

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

    // Issue #166 P2 #4 — stop the SENT-write reconciliation worker.
    // Same fire-and-forget contract as the sending-recovery worker
    // above. The worker's `stop()` drains the in-flight scan and never
    // throws on graceful shutdown.
    if (this.sentReconciliationWorker) {
      void this.sentReconciliationWorker.stop().catch(() => undefined);
      this.sentReconciliationWorker = null;
    }

    // Issue #166 P2 #3 — stop the Nostr persistence verifier.
    if (this.nostrPersistenceVerifier) {
      void this.nostrPersistenceVerifier.stop().catch(() => undefined);
      this.nostrPersistenceVerifier = null;
    }

    // Issue #174 — stop the per-token spent-state rescan worker.
    // Same fire-and-forget contract: the worker's `stop()` drains the
    // in-flight scan and never throws on graceful shutdown.
    if (this.spentStateRescanWorker) {
      void this.spentStateRescanWorker.stop().catch(() => undefined);
      this.spentStateRescanWorker = null;
    }

    // OUTBOX-SEND-FOLLOWUPS item #4 — stop the tombstone GC worker.
    if (this.tombstoneGcWorker) {
      void this.tombstoneGcWorker.stop().catch(() => undefined);
      this.tombstoneGcWorker = null;
    }

    // Task #169 — abort the worker AbortController BEFORE stopping the
    // workers. The signal is wired into both the worker's
    // `runFinalizationCycle` (which short-circuits between aggregator
    // calls) AND the `sleep` adapter (which rejects pending timers).
    // Aborting first ensures `worker.stop()`'s drain phase converges
    // promptly instead of waiting for the next 30s+ poll backoff.
    if (this._workerAbortController !== null) {
      try {
        this._workerAbortController.abort();
      } catch {
        // AbortController.abort() never throws on modern runtimes; the
        // try/catch is defense-in-depth for older shims.
      }
      this._workerAbortController = null;
    }

    // Phase 9.6.D — stop the sender-side finalization worker.
    // Fire-and-forget; `stop()` drains in-flight polls and never throws.
    if (this.finalizationWorkerSender) {
      void this.finalizationWorkerSender.stop().catch(() => undefined);
      this.finalizationWorkerSender = null;
    }
    // Task #151 — stop the recipient-side finalization worker.
    // Fire-and-forget; mirrors the sender path.
    if (this.finalizationWorkerRecipient) {
      void this.finalizationWorkerRecipient.stop().catch(() => undefined);
      this.finalizationWorkerRecipient = null;
    }
    this._recipientFinalizationQueue = null;
    // Clear in-memory outbox and context maps (no persistent side-effects).
    this._senderOutboxMap.clear();
    this._senderRequestContextMap.clear();
    this._recipientRequestContextMap.clear();
    this._recipientFinalizationContext.clear();
    // Wave 7 hygiene — wipe the recipient worker's save-failure streak
    // so per-tokenId entries don't outlive the context map. Otherwise a
    // long-running wallet that fails save() and then loses the token
    // (tombstone, address switch, manual delete) would accumulate dead
    // streak entries indefinitely.
    if (this._recipientSaveFailureStreakClear !== null) {
      try {
        this._recipientSaveFailureStreakClear();
      } catch {
        // The clearer is `Map.clear()` — non-throwing in practice — but
        // swallow defensively so destroy() stays total.
      }
      this._recipientSaveFailureStreakClear = null;
    }

    // Round 7 (FIX 2) — release the operator escape-hatch importer and
    // revalidate-cascaded runner. The default in-memory builders capture
    // their own Maps (manifestEntries / dispositionStorage / queueScanner
    // closures); without clearing the references here, those Maps
    // outlive the destroy() call and leak permanently for the lifetime
    // of the process even though the rest of PaymentsModule is gone.
    // A subsequent initialize() call will recreate fresh defaults via
    // the `=== null` gate, so a destroy()/initialize() cycle now starts
    // with a clean state instead of stale closures.
    this.inclusionProofImporter = null;
    this.revalidateCascadedRunner = null;

    // Round 7 (FIX 3) — release the shared per-tokenId mutex. The mutex
    // captures inflight Promises in its instance-scoped Map; clearing
    // the reference here lets the GC collect both the mutex and any
    // dangling per-tokenId state. A subsequent initialize() rebuilds a
    // fresh mutex (matches the `_workerAbortController` lifecycle).
    this._sharedPerTokenMutex = null;
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
      // Steelman item 2 — orphan-sweep race gate. See _dispatcherInFlightCount.
      this._dispatcherInFlightCount += 1;
      try {
        return await this.dispatchUxfConservativeSend(originalRequest);
      } finally {
        this._dispatcherInFlightCount -= 1;
      }
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
      this._dispatcherInFlightCount += 1;
      try {
        return await this.dispatchUxfInstantSend(originalRequest);
      } finally {
        this._dispatcherInFlightCount -= 1;
      }
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
      this._dispatcherInFlightCount += 1;
      try {
        return await this.dispatchTxfSend(originalRequest, txfFinalization);
      } finally {
        this._dispatcherInFlightCount -= 1;
      }
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
      //
      // INVARIANT (load-bearing for Item #14 Phase 2 work item 5 / PR #182):
      // `token.sdkData` MUST NOT be mutated alongside this status flip.
      // The JOIN-divergent loser detection in `loadFromStorageData`
      // (~line 15050) relies on `stateHash` staying STABLE across the
      // 'confirmed' → 'transferring' transition. If a future refactor
      // appends a synthetic pending-tx to outgoing source tokens'
      // `sdkData` (as already done for INCOMING tokens in `addToken`),
      // the in-memory `stateHash` would diverge from storage's
      // last-flushed `stateHash` — and the JOIN-divergent loser branch
      // would silently DROP legitimate in-flight sends as false-positive
      // multi-device race losers. If you need to mutate sdkData here,
      // update the divergent-state branch to use a more reliable
      // discriminator (e.g. an OUTBOX entry presence check).
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

      // Pre-validate ownership of every source token BEFORE any on-chain
      // work. See {@link validateSourceOwnership} for full rationale; the
      // short version is: in instant mode, the V6 bundle is shipped to the
      // recipient via Nostr BEFORE the per-direct-token commitments are
      // submitted to the aggregator. The split source's burn ALREADY runs
      // synchronously inside `buildSplitBundle`. If a direct token's
      // predicate-ownership check fails INSIDE the aggregator client
      // (state-transition-sdk's `submitTransferCommitment` line ~41), the
      // background submit silently logs an error but the foreground send()
      // still returns `status: 'completed'`. Meanwhile the split's burn is
      // on-chain, the change-token mint commitment may have already been
      // submitted in parallel — and the wallet's accounting loses track of
      // the change. Net effect: the sender's UCT balance can drop to 0 while
      // the recipient receives only the split slice (not the direct slice),
      // and the change token never materializes locally because the
      // change-token-creation callback is gated on the recipient mint proof
      // resolving (which never happens for the never-submitted commitment).
      // The repro is the pay-invoice manual test: Bob has 1000 + 10 UCT,
      // pays an 11 UCT invoice, loses 999 UCT change. By validating BEFORE
      // any on-chain work, the throw lands in the outer catch (line ~1520)
      // which restores source tokens to `confirmed` — no value lost.
      const ownershipCheckList: Array<{ uiToken: Token; sdkToken: SdkToken<any> } | Token> = [
        ...splitPlan.tokensToTransferDirectly,
      ];
      if (splitPlan.requiresSplit && splitPlan.tokenToSplit) {
        ownershipCheckList.push(splitPlan.tokenToSplit);
      }
      await this.validateSourceOwnership(ownershipCheckList, signingService);

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
   *
   * #202 — V5-pending TXF/UXF expressibility.
   *
   * Pre-#202 this saved `sdkData = '{"_pendingFinalization":...}'` — an
   * opaque wrapper with no `genesis` or `state`. Both serialization
   * layers then dropped/rejected it:
   *
   *   - `serialization/txf-serializer.ts:tokenToTxf` returned null, so
   *     `buildTxfStorageData` silently dropped the token.
   *   - `profile/profile-token-storage/flush-scheduler.ts` calls
   *     `UxfPackage.ingestAll` which calls `deconstructToken` whose
   *     `validateToken` (pre-#202) threw `INVALID_PACKAGE` on
   *     `_pendingFinalization`.
   *
   * Net effect: A's bundle CAR contained zero tokens after `receive()`;
   * cross-device profile sync (Device B reading A's CAR) saw an empty
   * inventory. Reported in #202.
   *
   * Fix: synthesize a UXF/TXF-valid sdkData mirroring what
   * `finalizeFromV5Bundle()` produces post-finalization, but with
   * `inclusionProof: null` on BOTH the genesis (mint not yet proven) and
   * the synthetic transfer transaction (transfer commitment not yet
   * proven). The sender-signed transfer authenticator rides as
   * `transactions[0]._wallet.authenticator` — preserved across UXF
   * deconstruct → assemble round-trip via the new `pending-authenticator`
   * element type (#202 schema extension).
   *
   * The `_pendingFinalization` marker is kept at the top level for
   * backward-compat with single-device KV restore (`PENDING_V5_TOKENS`)
   * and with `hasFinalizationPlan()` / `parsePendingFinalization()`.
   * It's a wallet-internal top-level field — UXF deconstruct drops it on
   * round-trip (UXF only preserves canonical typed elements). The
   * structural shape (null proofs + `_wallet.authenticator`) carries
   * enough for `resolveV5Token` to operate without the marker if it ever
   * needs to (future PR-B will refactor `resolveV5Token` to read from
   * the token shape directly).
   *
   * If parsing fails for any reason (malformed bundle), falls back to
   * the legacy opaque shape so the token is still recoverable via the
   * KV path — pre-#202 single-device behavior preserved on bad input.
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

    // #202 — Build a UXF/TXF-valid synthetic sdkData. See doc-comment.
    // On any parse failure, fall back to the legacy opaque
    // `{_pendingFinalization: ...}` shape (single-device KV path still
    // recovers the token; bundle CAR omits it as pre-#202).
    const sdkDataJson = (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mintDataJson = JSON.parse(bundle.recipientMintData) as Record<string, any>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const transferCommitmentJson = JSON.parse(bundle.transferCommitment) as Record<string, any>;
        const mintedTokenState = JSON.parse(bundle.mintedTokenStateJson);

        const transferTxData =
          transferCommitmentJson.transactionData !== undefined
            ? transferCommitmentJson.transactionData
            : transferCommitmentJson.data ?? null;

        // Sender-signed authenticator over the transfer commitment.
        // Carried inside `_wallet.authenticator` so it survives UXF
        // round-trip via the new `pending-authenticator` element type.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const transferAuth: any = transferCommitmentJson.authenticator;

        // The transfer commitment's authenticator signs over
        // (transactionHash, sourceStateHash). The `stateHash` field IS
        // the source state hash (= hash of `mintedTokenStateJson`).
        // Carry it as `_integrity.currentStateHash` so the wallet's
        // (tokenId, stateHash) dedup index produces stable identities
        // across save/load round-trips for V5-pending tokens.
        const currentStateHash: string | undefined =
          transferAuth && typeof transferAuth === 'object' && typeof transferAuth.stateHash === 'string'
            ? transferAuth.stateHash
            : undefined;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const syntheticPendingTx: Record<string, any> = {
          data: transferTxData,
          inclusionProof: null,
        };
        if (transferAuth && typeof transferAuth === 'object') {
          syntheticPendingTx._wallet = { authenticator: transferAuth };
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const syntheticTxf: Record<string, any> = {
          version: '2.0',
          state: mintedTokenState,
          genesis: {
            data: mintDataJson,
            inclusionProof: null,
          },
          transactions: transferTxData !== null ? [syntheticPendingTx] : [],
          nametags: [],
          _pendingFinalization: pendingData,
        };
        if (currentStateHash) {
          syntheticTxf._integrity = { currentStateHash };
        }
        return JSON.stringify(syntheticTxf);
      } catch (err) {
        logger.warn(
          'Payments',
          `saveUnconfirmedV5Token: failed to synthesize UXF-compatible shape for bundle ${bundle.splitGroupId.slice(0, 12)}, falling back to legacy opaque shape — token will be omitted from bundle CAR but recoverable via PENDING_V5_TOKENS KV: ${(err as Error)?.message ?? err}`,
        );
        return JSON.stringify({ _pendingFinalization: pendingData });
      }
    })();

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
      sdkData: sdkDataJson,
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

    // V6-RECV / faucet-flow fix (post PR #146 regression).
    //
    // Pre-fix, this method persisted the raw source TXF as-is. The
    // bundle's source token carries only the mint transaction (with its
    // own inclusionProof). The transfer commitment that flips ownership
    // to us is tracked separately as a proof-polling job in
    // `this.proofPollingJobs`. After a CLI invocation exits and a new
    // one runs:
    //
    //  - `determineTokenStatus` sees "1 tx with proof" → 'confirmed'
    //    (the original in-memory 'submitted' status is lost).
    //  - The proof-polling job persistence is fire-and-forget and may
    //    not complete before process exit; even when it does,
    //    `restoreProofPollingJobs` runs AFTER `loadFromStorageData`.
    //  - PR #146's `#144 L3 balance-model invariant` then moves the
    //    token to archive because the state.predicate is the sender's,
    //    not ours, AND `hasFinalizationPlan()` returns false.
    //
    // Net effect: faucet (and any V6 direct) receives become invisible
    // after the first CLI exit. The user sees "No tokens found" even
    // though tokens are on disk and history records the inbound.
    //
    // Fix: synthesize a pending transfer transaction in the persisted
    // sdkData using the commitment's transactionData with
    // `inclusionProof: null`. After this, the on-disk shape correctly
    // expresses "received but transfer not yet finalized" via the
    // standard pending-tx convention that V5 splits and other paths
    // already use:
    //
    //   - `determineTokenStatus` sees last tx with null proof → 'pending'.
    //   - `isReceivedLegacyPending(token)` returns true (recipient is us).
    //   - `hasFinalizationPlan(token)` returns true.
    //   - The balance-model invariant correctly skips archive.
    //   - `recoverStrandedReceivedTokens` recovers a fresh proof-polling
    //     job on next load.
    //
    // When `finalizeReceivedToken` runs (now or after restart), it
    // calls `finalizeTransferToken` which rebuilds the transactions
    // array from the SDK — the synthetic pending tx is replaced by the
    // proven one in finalizeTransferToken's output.
    let sdkData: string;
    {
      const rawSource: unknown =
        typeof sourceTokenInput === 'string'
          ? JSON.parse(sourceTokenInput)
          : sourceTokenInput;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawSourceObj = rawSource as any;
      const existingTxs: unknown[] = Array.isArray(rawSourceObj?.transactions)
        ? rawSourceObj.transactions
        : [];

      // Extract the commitment's transactionData AND authenticator. The
      // commitment is either a parsed object or a JSON-ish object; the
      // `transactionData` sub-object is what goes on-chain. We use it to
      // synthesize a pending tx with `inclusionProof: null` so subsequent
      // loads see a properly-shaped "transfer pending" token.
      //
      // Option B (token-local recovery state): we also embed the sender's
      // `authenticator` under a wallet-internal `_wallet` field on the
      // synthetic pending tx. The authenticator is the SENDER's signature
      // over (transactionHash, sourceStateHash) — the aggregator verifies
      // it without caring about the submitter's identity. Storing it
      // alongside the transactionData lets the recipient re-submit the
      // commitment after a wallet wipe + re-import-from-mnemonic, without
      // any cooperation from the (possibly offline) sender. This closes
      // the gap where proof-polling jobs (kept in a separate KV map, not
      // in the IPFS-published TXF) get lost on profile recreation.
      //
      // `_wallet` is a non-SDK field; `normalizeSdkTokenToStorage` uses
      // structuredClone, which preserves unknown fields. On finalize,
      // `SdkToken.fromJSON` strips it (typed deserialization), and
      // `finalizedSdkToken.toJSON()` writes the clean post-transition
      // shape — so `_wallet` is naturally cleaned up.
      let pendingTxData: unknown = null;
      let pendingAuthenticator: unknown = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ci = commitmentInput as any;
        if (ci && typeof ci === 'object') {
          if (ci.transactionData !== undefined) {
            pendingTxData = ci.transactionData;
          } else if (ci.data !== undefined) {
            pendingTxData = ci.data;
          }
          // Authenticator can come as plain JSON ({publicKey, signature,
          // stateHash}) or as a class instance with toJSON(). Normalize to
          // the JSON shape so the recovery path can pass it straight to
          // `TransferCommitment.fromJSON({...})`.
          if (ci.authenticator !== undefined && ci.authenticator !== null) {
            const auth = ci.authenticator as { toJSON?: () => unknown };
            pendingAuthenticator =
              typeof auth.toJSON === 'function' ? auth.toJSON() : ci.authenticator;
          }
        }
      } catch {
        // Best-effort — fall through. The token will still be saved
        // (without the synthetic pending tx) and finalization will
        // recover the state when the proof arrives in this session.
        pendingTxData = null;
        pendingAuthenticator = null;
      }

      // Defensive: avoid double-appending. If the last existing tx already
      // has `inclusionProof: null` (or missing — see the parser tweaks in
      // `determineTokenStatus` / `isReceivedLegacyPending` which treat
      // missing as null per the canonical V5/V6 protocol), the source TXF
      // already encodes a pending transfer. Don't append a second one.
      const lastExistingTx = existingTxs[existingTxs.length - 1] as
        | { inclusionProof?: unknown }
        | undefined;
      const lastExistingHasNullProof =
        lastExistingTx !== undefined &&
        (lastExistingTx.inclusionProof === null ||
          lastExistingTx.inclusionProof === undefined);

      const syntheticPendingTx: Record<string, unknown> = {
        data: pendingTxData,
        inclusionProof: null,
      };
      if (pendingAuthenticator !== null) {
        // Wallet-internal recovery state — Option B (token-local).
        syntheticPendingTx._wallet = { authenticator: pendingAuthenticator };
      }

      const augmentedSource =
        pendingTxData !== null && !lastExistingHasNullProof
          ? {
              ...rawSourceObj,
              transactions: [...existingTxs, syntheticPendingTx],
            }
          : rawSourceObj;

      sdkData = JSON.stringify(augmentedSource);
    }

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
        // Persist the source token JSON so that on process restart we can
        // restore the job (#144 layer 1). `sdkData` is the raw source TXF
        // string — same value that was passed in as `sourceTokenInput`.
        sourceTokenJson: sdkData,
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
      const drain = await this.drainPendingFinalizations({
        timeoutMs: opts.timeout ?? 60_000,
        pollIntervalMs: opts.pollInterval ?? 2_000,
        onProgress: opts.onProgress,
      });
      result.finalization = drain.finalization;
      result.finalizationDurationMs = drain.durationMs;
      result.timedOut = drain.timedOut;
    } else {
      // Non-finalize: submit commitments once (fire-and-forget style)
      result.finalization = await this.resolveUnconfirmed();
    }

    return result;
  }

  /**
   * Drain pending V5 finalizations until none remain or the timeout
   * elapses. Shared by `receive({ finalize: true })` and `sync()` — the
   * latter calls this before flushing to token-storage providers so the
   * published CAR doesn't drop pending tokens (whose `sdkData` lacks
   * `genesis`/`state` and round-trips through `tokenToTxf` as null).
   *
   * Short-circuits to a no-op when:
   *  - No tokens are in `'submitted'` or `'pending'` state at entry, OR
   *  - The oracle has no `getStateTransitionClient()` / `getTrustBase()`
   *    (a wallet without aggregator wiring can't resolve V5 commitments
   *    no matter how long it polls — preserves the pre-fix behavior of
   *    quietly returning rather than blocking for the full timeout).
   */
  private async drainPendingFinalizations(opts: {
    timeoutMs: number;
    pollIntervalMs: number;
    onProgress?: (result: UnconfirmedResolutionResult) => void;
  }): Promise<{
    finalization?: UnconfirmedResolutionResult;
    durationMs: number;
    timedOut: boolean;
    skipped: boolean;
  }> {
    const startTime = Date.now();

    // Drain race fix — must also wait for any inbound transfer pipelines
    // that haven't yet reached `addToken` (their tokens are not in
    // `this.tokens` yet, so the status scan below would miss them).
    // See `inflightReceiveCount` doc for why.
    const hasUnconfirmedOrInflight = (): boolean =>
      this.inflightReceiveCount > 0 ||
      Array.from(this.tokens.values()).some(
        (t) => t.status === 'submitted' || t.status === 'pending',
      );

    // Drain ingest worker pool first (UXF v1 path, defense in depth).
    // The pool's queue may hold accepted-but-not-yet-processed bundles;
    // waiting here serializes the drain against in-flight worker
    // processing so the post-drain wallet snapshot includes their
    // resulting tokens. Best-effort: any failure (timeout, pool not
    // installed) falls through to the legacy in-flight wait below.
    if (this.ingestPool) {
      try {
        await this.ingestPool.drainQueue(opts.timeoutMs);
      } catch (err) {
        logger.debug(
          'Payments',
          '[DRAIN] ingestPool.drainQueue threw or timed out (continuing):',
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Fast path: nothing to drain.
    if (!hasUnconfirmedOrInflight()) {
      return { durationMs: 0, timedOut: false, skipped: true };
    }

    // No-oracle short-circuit: without stClient + trustBase,
    // resolveUnconfirmed() early-exits every iteration and the polling
    // loop would block for the full timeoutMs with zero progress.
    const stClient = this.deps!.oracle.getStateTransitionClient?.();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trustBase = (this.deps!.oracle as any).getTrustBase?.();
    if (!stClient || !trustBase) {
      logger.debug(
        'Payments',
        '[V5-RESOLVE] drainPendingFinalizations: oracle not wired (no stClient/trustBase) — skipping drain',
      );
      return { durationMs: 0, timedOut: hasUnconfirmedOrInflight(), skipped: true };
    }

    let finalization: UnconfirmedResolutionResult | undefined;

    while (Date.now() - startTime < opts.timeoutMs) {
      const resolution = await this.resolveUnconfirmed();
      finalization = resolution;
      if (opts.onProgress) opts.onProgress(resolution);

      if (!hasUnconfirmedOrInflight()) break;

      await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
      await this.load();
    }

    return {
      finalization,
      durationMs: Date.now() - startTime,
      timedOut: hasUnconfirmedOrInflight(),
      skipped: false,
    };
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

    const submittedCount = Array.from(this.tokens.values()).filter(
      t => t.status === 'submitted' || t.status === 'pending'
    ).length;
    logger.debug('Payments', `[V5-RESOLVE] resolveUnconfirmed: ${submittedCount} submitted/pending token(s) to process`);

    for (const [tokenId, token] of this.tokens) {
      // #144 L2: accept both 'submitted' (in-process V5/V6-direct) and
      // 'pending' (V6-direct after save→load round-trip — txfToToken flips
      // the status when the latest tx has `inclusionProof: null`).
      if (token.status !== 'submitted' && token.status !== 'pending') continue;

      // Check for pending finalization metadata (V5 split bundles).
      const pending = this.parsePendingFinalization(token.sdkData);

      if (pending?.type === 'v5_bundle') {
        logger.debug('Payments', `[V5-RESOLVE] Processing ${tokenId.slice(0, 16)}... stage=${pending.stage} attempt=${pending.attemptCount}`);
        const progress = await this.resolveV5Token(tokenId, token, pending, stClient, trustBase, signingService);
        logger.debug('Payments', `[V5-RESOLVE] Result for ${tokenId.slice(0, 16)}...: ${progress} (stage now: ${pending.stage})`);
        result.details.push({ tokenId, stage: pending.stage, status: progress });
        if (progress === 'resolved') result.resolved++;
        else if (progress === 'failed') result.failed++;
        else result.stillPending++;
        continue;
      }

      // #144 L2: V6-direct legacy entries (no `_pendingFinalization`).
      // If a persisted proof-polling job is tracking this token, attempt
      // finalization in our own cadence (defense-in-depth alongside the
      // ~2s background queue). If no job is registered, the token is
      // stranded — `recoverStrandedReceivedTokens` (L3 migration) handles
      // it on first load() after upgrade.
      if (this.isReceivedLegacyPending(token)) {
        const progress = await this.resolveLegacyReceivedToken(tokenId, token);
        const detailStatus: 'resolved' | 'pending' | 'failed' =
          progress === 'resolved' ? 'resolved'
          : progress === 'failed' ? 'failed'
          : 'pending';
        result.details.push({ tokenId, stage: 'v6_direct', status: detailStatus });
        if (progress === 'resolved') result.resolved++;
        else if (progress === 'failed') result.failed++;
        else result.stillPending++;
        continue;
      }

      // Local-finalize fallback for tokens whose state.predicate doesn't
      // match our wallet AND whose last tx is a fully-proven transfer
      // targeting us. These come from two scenarios:
      //   1. Sender pre-finalized (e.g., faucet shipped `{sourceToken,
      //      transferTx}` with proof) but our receive path's finalize
      //      threw — saved as status='pending' by the path C / D fix.
      //   2. Profile recovery from a CAR published by another device
      //      that contained un-finalized pending tokens — we now have
      //      the proven transfer tx on disk but state.predicate is
      //      still the sender's. We must apply the transition locally
      //      to update state.predicate to ours.
      // The transition is offline (the proof is already there). We just
      // need to call `stClient.finalizeTransaction(sourceToken, ourState,
      // transferTx, nametagTokens)` to construct the post-transition
      // token. On success, persist the new sdkData with status='confirmed';
      // on failure, leave the token unchanged and report stillPending so
      // the next periodic retry can try again.
      const localFinalizeResult = await this.tryLocalFinalizeUnconfirmed(
        tokenId,
        token,
        stClient,
        trustBase,
      );
      if (localFinalizeResult === 'resolved') {
        result.details.push({ tokenId, stage: 'local_finalize', status: 'resolved' });
        result.resolved++;
        continue;
      } else if (localFinalizeResult === 'failed') {
        result.details.push({ tokenId, stage: 'local_finalize', status: 'failed' });
        result.failed++;
        continue;
      } else if (localFinalizeResult === 'skipped') {
        // Some other shape we don't know about — count as still-pending.
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 16)}: no pending finalization metadata, no recipient match — skipping`);
        result.stillPending++;
      } else {
        // 'stillPending' — local finalize didn't apply (no recipient
        // match or no proof yet), but the token is legitimately pending.
        result.details.push({ tokenId, stage: 'local_finalize', status: 'pending' });
        result.stillPending++;
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

    // Only start if there are unconfirmed tokens to resolve.
    // #144: include 'pending' status too — V6-direct receives flip from
    // 'submitted' to 'pending' after save→load and would never re-engage
    // the periodic retry otherwise.
    const hasUnconfirmed = Array.from(this.tokens.values()).some(
      (t) => t.status === 'submitted' || t.status === 'pending',
    );
    if (!hasUnconfirmed) {
      logger.debug('Payments', '[V5-RESOLVE] scheduleResolveUnconfirmed: no submitted/pending tokens, not starting timer');
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
   * #144 L2/L3 — does this token look like a V6-direct received-but-
   * not-finalized token? Conditions:
   *   1. sdkData parses as TXF with transactions
   *   2. last tx has `inclusionProof === null`
   *   3. last tx's `data.recipient.address` resolves to our wallet
   *      (DIRECT://<our> or PROXY://<our-nametag>)
   *
   * Used by `resolveUnconfirmed` and `recoverStrandedReceivedTokens` to
   * distinguish stranded receives from sends and from other shapes.
   */
  private isReceivedLegacyPending(token: Token): boolean {
    if (!token.sdkData) return false;
    let parsed: { transactions?: unknown };
    try {
      parsed = JSON.parse(token.sdkData);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object') return false;
    const txs = (parsed as { transactions?: unknown[] }).transactions;
    if (!Array.isArray(txs) || txs.length === 0) return false;
    const lastTx = txs[txs.length - 1] as {
      inclusionProof?: unknown;
      data?: { recipient?: { address?: string } };
    };
    // Canonical default: missing inclusionProof === null (the V5/V6 protocol
    // treats both `inclusionProof: null` and the absence of the field as
    // "transaction is pending"). Without this default, a producer that
    // omits the field would see `lastTx.inclusionProof === undefined`,
    // fail this `!== null` check, and incorrectly be classified as
    // not-pending — leaving the token stranded by the balance-model
    // invariant in `loadFromStorageData`.
    const proof = lastTx.inclusionProof === undefined ? null : lastTx.inclusionProof;
    if (proof !== null) return false;
    const recipientAddr = lastTx.data?.recipient?.address;
    if (typeof recipientAddr !== 'string') return false;

    // DIRECT match — `identity.directAddress` is normalized to
    // `DIRECT://...`; tx recipient should match exactly.
    const directAddr = this.deps!.identity.directAddress;
    if (directAddr && recipientAddr === directAddr) return true;

    // PROXY exact match — steelman FIX F (#144). Requires the
    // `proxyAddressCache` to have been primed via
    // `primeProxyAddressCache` (called from `load()`). Tokens addressed
    // to a PROXY we don't hold are rejected, preventing recover-load
    // amplification by malicious peers crafting PROXY://<garbage> TXFs.
    if (recipientAddr.startsWith('PROXY://')) {
      return this.proxyAddressCache.has(recipientAddr);
    }

    return false;
  }

  /**
   * Steelman FIX F (#144): populate `proxyAddressCache` with the full
   * PROXY:// address(es) for our held nametag(s). Called from `load()`
   * after nametags are loaded but BEFORE `recoverStrandedReceivedTokens`
   * runs, so the recovery scan sees an accurate cache.
   *
   * Best-effort: errors are logged and the relevant entry omitted. An
   * empty cache means PROXY-mode receives can't be recovered, but the
   * DIRECT-mode path (the common case) is unaffected.
   */
  private async primeProxyAddressCache(): Promise<void> {
    this.proxyAddressCache.clear();
    for (const nametagRecord of this.nametags) {
      const tokenJson = nametagRecord?.token as unknown;
      if (!tokenJson) continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nametagToken = await SdkToken.fromJSON(tokenJson as any) as SdkToken<any>;
        const { ProxyAddress } = await import(
          '@unicitylabs/state-transition-sdk/lib/address/ProxyAddress'
        );
        const proxy = await ProxyAddress.fromTokenId(nametagToken.id);
        this.proxyAddressCache.add(proxy.address);
      } catch (err) {
        logger.debug(
          'Payments',
          `[PROXY-CACHE] Failed to derive PROXY for nametag ${nametagRecord?.name ?? '?'}:`,
          err,
        );
      }
    }
  }

  /**
   * #144 L3 — does this token have an in-flight finalization plan?
   * A "plan" is one of:
   *   1. `_pendingFinalization` marker on sdkData (V5 split bundles)
   *   2. A live proof-polling job in `this.proofPollingJobs`
   *   3. The token "looks like a V6-direct received-but-not-finalized"
   *      target for us (eligible for `recoverStrandedReceivedTokens`)
   *
   * Used by `loadFromStorageData`'s balance-model invariant check: tokens
   * whose latest state isn't ours AND have no plan are moved to the
   * archive map per the canonical model (see #144 spec §3 and #143's
   * balance-model state-machine refinement).
   */
  private hasFinalizationPlan(token: Token): boolean {
    if (this.parsePendingFinalization(token.sdkData)) return true;
    if (this.proofPollingJobs.has(token.id)) return true;
    if (this.isReceivedLegacyPending(token)) return true;
    return false;
  }

  /**
   * #144 L3 — does the token's latest STATE predicate resolve to this
   * wallet? Distinct from "is the latest tx's recipient us": this asks
   * whether the SDK considers us the current owner.
   *
   * Conservative implementation: if we can't determine ownership with
   * confidence, return `true` (keep the token visible). Only return
   * `false` for the unambiguous case where the latest state's encoded
   * publicKey differs from our wallet's signing key.
   *
   * **Critical**: this check compares against the wallet's SIGNING-SERVICE
   * publicKey (the key used by `UnmaskedPredicate.create` /
   * `MaskedPredicate.create` to embed in predicate bytes), NOT the
   * wallet's chainPubkey. Pre-fix this used `identity.chainPubkey`; for
   * wallets where those two keys differ (e.g. different HD-derivation
   * paths or curve mappings), the check always returned false and PR
   * #146's balance-model invariant archived every received token —
   * faucet receives became invisible after the first CLI exit despite
   * the on-disk state.predicate actually encoding our signing pubkey.
   *
   * The signing pubkey is cached lazily on first call via
   * `_signingPublicKeyHex`; subsequent calls are pure-sync. The cache
   * is invalidated by `clear()` (which sets `this.deps = null`); a new
   * wallet identity always starts with an empty cache.
   */
  private latestStatePredicateMatchesWallet(token: Token): boolean {
    if (!token.sdkData) return true;
    let parsed: { state?: { predicate?: string | { publicKey?: string } } };
    try {
      parsed = JSON.parse(token.sdkData);
    } catch {
      return true;
    }
    const predicate = parsed?.state?.predicate;
    if (!predicate) return true;

    // Use the cached signing-service pubkey when available. Fallback to
    // identity.chainPubkey when the signing pubkey hasn't been resolved
    // yet (only happens at first load, before any send/receive has run
    // — in that window we err on the side of "keep visible").
    const signingPubkey = this._signingPublicKeyHex;
    const chainPubkey = this.deps!.identity.chainPubkey?.toLowerCase();
    const candidates = [signingPubkey, chainPubkey].filter(
      (k): k is string => typeof k === 'string' && k.length > 0,
    );
    if (candidates.length === 0) return true;

    if (typeof predicate === 'string') {
      const predLower = predicate.toLowerCase();
      return candidates.some((k) => predLower.includes(k));
    }
    if (typeof predicate === 'object' && typeof predicate.publicKey === 'string') {
      const pkLower = predicate.publicKey.toLowerCase();
      return candidates.some((k) => pkLower === k);
    }
    return true;
  }

  /**
   * #144 L3 migration — recover stranded V6-direct received tokens that
   * exist in the active map with `status === 'pending'` but have no
   * persisted proof-polling job (e.g. wallets upgraded from a pre-#144
   * SDK build). For each, derive `requestIdHex` from the source TXF's
   * last transaction data and register a fresh proof-polling job.
   *
   * The reconstructed job uses an empty `commitmentJson` and is finalized
   * via `finalizeStrandedReceivedToken` instead of the standard
   * `finalizeReceivedToken` — the migration path patches the source TXF's
   * last-tx inclusionProof in place rather than constructing a
   * `TransferCommitment` (we don't have the sender's authenticator).
   *
   * Idempotent: tokens that already have a proof-polling job are skipped.
   * Tokens that fail to derive requestIdHex (e.g. malformed sdkData) are
   * left in the active map with a debug log.
   *
   * Returns the count of jobs registered.
   */
  private async recoverStrandedReceivedTokens(): Promise<number> {
    let recovered = 0;
    for (const [tokenId, token] of this.tokens) {
      if (token.status !== 'pending') continue;
      if (this.proofPollingJobs.has(tokenId)) continue;
      if (this.parsePendingFinalization(token.sdkData)) continue;
      if (!this.isReceivedLegacyPending(token)) continue;

      // Parse sdkData to reach the last tx + source state.
      if (!token.sdkData) continue;
      let parsed: {
        transactions?: Array<{ data?: unknown; inclusionProof?: unknown }>;
      };
      try {
        parsed = JSON.parse(token.sdkData);
      } catch (err) {
        logger.debug(
          'Payments',
          `[V6-RECOVER] ${tokenId.slice(0, 12)}: sdkData parse failed: ${(err as Error).message}`,
        );
        continue;
      }
      const txs = parsed.transactions;
      if (!Array.isArray(txs) || txs.length === 0) continue;
      const lastTxJson = txs[txs.length - 1];
      if (!lastTxJson || lastTxJson.data == null) continue;

      try {
        // Derive requestIdHex from source state's predicate publicKey +
        // sourceStateHash (mirrors the recipient UXF worker recipe at
        // line ~1876 — same canonical derivation aggregator uses).
        const txData = await TransferTransactionData.fromJSON(lastTxJson.data);
        const senderPredicate = await PredicateEngineService.createPredicate(
          txData.sourceState.predicate,
        );
        const senderPubkey = (senderPredicate as unknown as { publicKey?: Uint8Array }).publicKey;
        if (!(senderPubkey instanceof Uint8Array) || senderPubkey.length === 0) {
          logger.debug(
            'Payments',
            `[V6-RECOVER] ${tokenId.slice(0, 12)}: sender predicate has no publicKey, skipping`,
          );
          continue;
        }
        const sourceStateHash = await txData.sourceState.calculateHash();
        const requestId = await RequestId.create(senderPubkey, sourceStateHash);
        const requestIdHex = requestId.toJSON();

        // Build the source-at-state-N-1 by stripping the last tx. This is
        // the same shape `assembleAtState(tokenId, txCount - 1)` produces
        // for the UXF path. `SdkToken.fromJSON` only accepts source tokens
        // whose transactions all have inclusionProofs.
        const sourceTokenJsonObj = {
          ...parsed,
          transactions: txs.slice(0, -1),
        };
        const sourceTokenJson = JSON.stringify(sourceTokenJsonObj);

        // Option B (token-local recovery): if the synthetic pending tx
        // carries a `_wallet.authenticator`, we can reconstruct a full
        // `TransferCommitment` and re-submit it to the aggregator. The
        // authenticator is the SENDER's signature — the aggregator
        // verifies it without caring who submits. This closes the
        // recovery gap where a sender's CLI exits before its
        // fire-and-forget background submit completes: the recipient,
        // after a profile wipe + re-import-from-mnemonic, can push the
        // commitment on the sender's behalf.
        //
        // If the embedded authenticator is missing or fails to parse,
        // fall back to the legacy `commitmentJson: ''` path — the
        // polling queue's `getProof(requestIdHex)` fallback still works
        // when the sender DID submit the commitment.
        let recoveredCommitmentJson = '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const walletField = (lastTxJson as any)._wallet;
        if (
          walletField &&
          typeof walletField === 'object' &&
          walletField !== null &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (walletField as any).authenticator
        ) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const authJson = (walletField as any).authenticator;
            const commitmentObj = {
              requestId: requestIdHex,
              transactionData: lastTxJson.data,
              authenticator: authJson,
            };
            // Validate via fromJSON to catch malformed authenticators
            // now rather than at submit time.
            await TransferCommitment.fromJSON(commitmentObj);
            recoveredCommitmentJson = JSON.stringify(commitmentObj);
            logger.debug(
              'Payments',
              `[V6-RECOVER] ${tokenId.slice(0, 12)}: extracted embedded authenticator — full commitment recovery enabled`,
            );
          } catch (cmtErr) {
            logger.debug(
              'Payments',
              `[V6-RECOVER] ${tokenId.slice(0, 12)}: embedded authenticator invalid (${(cmtErr as Error)?.message ?? cmtErr}); falling back to getProof-only path`,
            );
          }
        }

        // Register a proof-polling job. When `commitmentJson` is set,
        // the polling queue's `waitForProofSdk(commitment)` path is
        // used; when empty, it falls back to `getProof(requestIdHex)`
        // (#144 L3 path).
        const lastTxJsonSnapshot = JSON.parse(JSON.stringify(lastTxJson));
        this.proofPollingJobs.set(tokenId, {
          tokenId,
          requestIdHex,
          commitmentJson: recoveredCommitmentJson,
          sourceTokenJson,
          startedAt: Date.now(),
          attemptCount: 0,
          lastAttemptAt: 0,
          onProofReceived: async (tid) => {
            await this.finalizeStrandedReceivedToken(
              tid,
              sourceTokenJson,
              lastTxJsonSnapshot,
            );
          },
        });

        // If we have the full commitment, fire-and-forget submit so the
        // aggregator processes it even if the original sender never did.
        // The submit is idempotent on the aggregator side; the polling
        // queue picks up the proof on its next tick.
        if (recoveredCommitmentJson) {
          const commitmentJsonForSubmit = recoveredCommitmentJson;
          (async () => {
            try {
              const stClient = this.deps!.oracle.getStateTransitionClient?.() as
                | StateTransitionClient
                | undefined;
              if (!stClient) return;
              const commitment = await TransferCommitment.fromJSON(
                JSON.parse(commitmentJsonForSubmit),
              );
              const response = await stClient.submitTransferCommitment(commitment);
              logger.debug(
                'Payments',
                `[V6-RECOVER] ${tokenId.slice(0, 12)}: re-submitted sender's commitment, status=${(response as { status?: unknown })?.status ?? 'unknown'}`,
              );
            } catch (submitErr) {
              // Non-fatal — the polling queue's getProof fallback still
              // runs. The aggregator may already have the commitment
              // from the sender's original submit attempt.
              logger.debug(
                'Payments',
                `[V6-RECOVER] ${tokenId.slice(0, 12)}: commitment re-submit failed (${(submitErr as Error)?.message ?? submitErr}); polling queue will retry via getProof`,
              );
            }
          })();
        }

        recovered++;
        logger.debug(
          'Payments',
          `[V6-RECOVER] Registered recovery job for stranded token ${tokenId.slice(0, 12)} (requestId=${requestIdHex.slice(0, 16)}..., commitmentRecovered=${recoveredCommitmentJson !== ''})`,
        );
      } catch (err) {
        logger.debug(
          'Payments',
          `[V6-RECOVER] ${tokenId.slice(0, 12)}: requestIdHex derivation failed: ${(err as Error)?.message ?? err}`,
        );
      }
    }

    if (recovered > 0) {
      this.startProofPolling();
      this.saveProofPollingJobs().catch((err) =>
        logger.debug('Payments', '[V6-PERSIST] saveProofPollingJobs after recover failed:', err),
      );
    }
    return recovered;
  }

  /**
   * #144 L3 migration — finalize a stranded V6-direct received token
   * once its inclusion proof arrives. Unlike `finalizeReceivedToken`
   * (which uses a real `TransferCommitment`), this path patches the
   * lastTx's `inclusionProof` field in place and calls
   * `TransferTransaction.fromJSON` directly. The patched JSON is then
   * fed to `finalizeTransferToken` which produces the recipient's
   * finalized SDK token.
   */
  private async finalizeStrandedReceivedToken(
    tokenId: string,
    sourceTokenJson: string,
    lastTxJson: Record<string, unknown>,
  ): Promise<void> {
    try {
      const job = this.proofPollingJobs.get(tokenId);
      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trustBase = (this.deps!.oracle as any).getTrustBase?.();
      if (!stClient || !trustBase || !job) {
        logger.debug('Payments', `[V6-RECOVER] Cannot finalize ${tokenId.slice(0, 12)} — missing client/trustBase/job`);
        return;
      }

      // Fetch the proof one more time (the queue already saw it, but it
      // doesn't pass the proof through to the callback).
      let proofJson: unknown = null;
      const proof = await this.deps!.oracle.getProof(job.requestIdHex);
      if (proof) {
        // proof may be an InclusionProof instance or a plain JSON object —
        // `TransferTransaction.fromJSON` expects the JSON shape, so
        // normalize via `toJSON()` when available.
        const proofWithToJson = proof as { toJSON?: () => unknown };
        proofJson = typeof proofWithToJson.toJSON === 'function'
          ? proofWithToJson.toJSON()
          : proof;
      }
      if (!proofJson) {
        logger.debug('Payments', `[V6-RECOVER] Proof for ${tokenId.slice(0, 12)} unavailable on re-fetch — leaving for next tick`);
        return;
      }

      // Patch the lastTxJson with the now-available inclusionProof and
      // reconstruct the SDK transfer transaction.
      const finalizedTxJson = { ...lastTxJson, inclusionProof: proofJson };
      const transferTx = await TransferTransaction.fromJSON(finalizedTxJson);

      // Source token at state N-1 (last tx stripped — see
      // `recoverStrandedReceivedTokens`).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sourceToken = await SdkToken.fromJSON(JSON.parse(sourceTokenJson)) as SdkToken<any>;

      const finalizedSdkToken = await this.finalizeTransferToken(
        sourceToken,
        transferTx,
        stClient,
        trustBase,
      );

      const token = this.tokens.get(tokenId);
      if (!token) {
        logger.debug('Payments', `[V6-RECOVER] Token ${tokenId.slice(0, 12)} disappeared before finalize completed`);
        return;
      }
      const finalizedToken: Token = {
        ...token,
        status: 'confirmed',
        updatedAt: Date.now(),
        sdkData: JSON.stringify(finalizedSdkToken.toJSON()),
      };
      this.tokens.set(tokenId, finalizedToken);
      await this.save();

      // Update spend-queue cache with newly-confirmed token.
      const amount = this.extractCoinAmountForCache(finalizedSdkToken, finalizedToken.coinId);
      if (amount > 0n) {
        this.parsedTokenCache.set(tokenId, { token: finalizedToken, sdkToken: finalizedSdkToken, amount });
        this.spendQueue.notifyChange(finalizedToken.coinId);
      }

      this.deps!.emitEvent('transfer:confirmed', {
        id: crypto.randomUUID(),
        status: 'completed',
        tokens: [finalizedToken],
        tokenTransfers: [],
      });

      logger.debug('Payments', `[V6-RECOVER] Finalized stranded receive ${tokenId.slice(0, 12)} → confirmed`);
    } catch (err) {
      logger.error('Payments', `[V6-RECOVER] Failed to finalize stranded receive ${tokenId.slice(0, 12)}:`, err);
    }
  }

  /**
   * #144 L2 — attempt to finalize a V6-direct legacy token (no
   * `_pendingFinalization` marker) using a persisted proof-polling job.
   * Runs from `resolveUnconfirmed`'s slower cadence as defense-in-depth
   * alongside the ~2s background queue.
   *
   * Returns:
   *   - 'resolved' when proof arrives and finalize succeeds
   *   - 'stillPending' when proof not ready yet (or no persisted job)
   *   - 'failed' on hard finalize errors
   */
  /**
   * Try to apply a pending transfer transition locally. Used by
   * `resolveUnconfirmed` to recover tokens whose state.predicate is the
   * sender's (un-finalized) but whose on-disk last transaction is a
   * fully-proven transfer targeting our wallet.
   *
   * Returns:
   *   - `'resolved'`   — local finalization succeeded; sdkData and status
   *                      were updated; the token now has our predicate.
   *   - `'failed'`     — finalization threw a hard error (e.g. PROXY
   *                      address mismatch); the token is unchanged.
   *   - `'stillPending'` — last tx has null/missing inclusionProof (a
   *                      genuine pending state — wait for the proof to
   *                      arrive). Token unchanged.
   *   - `'skipped'`    — token shape doesn't qualify for local finalize
   *                      (no transactions, no sourceState, predicate
   *                      already matches our signing key, etc.).
   */
  private async tryLocalFinalizeUnconfirmed(
    tokenId: string,
    token: Token,
    stClient: StateTransitionClient,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trustBase: any,
  ): Promise<'resolved' | 'failed' | 'stillPending' | 'skipped'> {
    if (!token.sdkData) return 'skipped';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tokenJson: any;
    try {
      tokenJson = JSON.parse(token.sdkData);
    } catch {
      return 'skipped';
    }
    const txs: unknown[] = Array.isArray(tokenJson?.transactions)
      ? tokenJson.transactions
      : [];
    if (txs.length === 0) return 'skipped';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lastTxJson: any = txs[txs.length - 1];
    if (!lastTxJson || typeof lastTxJson !== 'object') return 'skipped';

    // Canonical default: missing inclusionProof === null.
    const lastTxProof =
      lastTxJson.inclusionProof === undefined ? null : lastTxJson.inclusionProof;
    if (lastTxProof === null) {
      // Genuinely pending — wait for proof to land via the proof-polling
      // queue. Not our case to fix.
      return 'stillPending';
    }

    // Source state at N-1 lives inside the last transfer tx's data.
    const sourceStateJson = lastTxJson.data?.sourceState;
    if (!sourceStateJson) return 'skipped';

    // Quick check: does the current state.predicate already match our
    // signing key? If yes, we're already finalized — no work needed.
    const ourSigningPk = this._signingPublicKeyHex;
    const currentStatePredicate = tokenJson?.state?.predicate;
    if (
      ourSigningPk !== null &&
      typeof currentStatePredicate === 'string' &&
      currentStatePredicate.toLowerCase().includes(ourSigningPk)
    ) {
      return 'skipped';
    }

    // **Critical**: predicate mismatch alone is NOT a signal that the
    // token is "meant for us". A token whose state.predicate doesn't
    // match our wallet could be:
    //   (a) meant for us but un-finalized (the case we want to fix), OR
    //   (b) meant for someone else (in which case applying our predicate
    //       would corrupt the chain and the SDK would reject it
    //       downstream, but only after on-chain side-effects).
    // Distinguish by inspecting the transfer transaction's
    // `data.recipient.address` — only proceed when it matches one of
    // OUR destination addresses:
    //   - identity.directAddress (DIRECT:// scheme), OR
    //   - any PROXY:// derived from a nametag we hold (handled via
    //     `proxyAddressCache`, primed at load time from `this.nametags`).
    const recipientAddr: unknown = lastTxJson.data?.recipient?.address;
    if (typeof recipientAddr !== 'string' || recipientAddr.length === 0) {
      return 'skipped';
    }
    const ourDirect = this.deps!.identity.directAddress;
    const isOurDirect =
      typeof ourDirect === 'string' && recipientAddr === ourDirect;
    const isOurProxy =
      recipientAddr.startsWith('PROXY://') &&
      this.proxyAddressCache.has(recipientAddr);
    if (!isOurDirect && !isOurProxy) {
      // Not addressed to us — don't try to finalize it. Could be a
      // token someone else's bundle smuggled past dedup, or a token we
      // accidentally retain from a prior identity (unlikely but
      // defensive). Skip silently.
      return 'skipped';
    }

    // Reconstruct sourceToken at state N-1.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sourceToken: SdkToken<any>;
    let transferTx: TransferTransaction;
    try {
      const sourceTokenJson = {
        ...tokenJson,
        state: sourceStateJson,
        transactions: txs.slice(0, -1),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sourceToken = await SdkToken.fromJSON(sourceTokenJson) as SdkToken<any>;
      transferTx = await TransferTransaction.fromJSON(lastTxJson);
    } catch (err) {
      logger.debug(
        'Payments',
        `[LOCAL-FINALIZE] ${tokenId.slice(0, 16)}: parse failed (${err instanceof Error ? err.message : String(err)})`,
      );
      return 'skipped';
    }

    try {
      const finalizedToken = await this.finalizeTransferToken(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sourceToken as any,
        transferTx,
        stClient,
        trustBase,
      );
      const finalizedSdkData = JSON.stringify(finalizedToken.toJSON());
      const updatedToken: Token = {
        ...token,
        status: 'confirmed',
        updatedAt: Date.now(),
        sdkData: finalizedSdkData,
      };
      this.tokens.set(tokenId, updatedToken);

      // Rebuild parsed-cache entry so the spend planner sees the new
      // confirmed balance immediately.
      try {
        const amount = this.extractCoinAmountForCache(
          finalizedToken,
          token.coinId,
        );
        if (amount > 0n) {
          this.parsedTokenCache.set(tokenId, {
            token: updatedToken,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sdkToken: finalizedToken as any,
            amount,
          });
          this.spendQueue.notifyChange(token.coinId);
        }
      } catch {
        // Non-fatal — the next reload rebuilds the cache.
      }

      logger.debug(
        'Payments',
        `[LOCAL-FINALIZE] ${tokenId.slice(0, 16)}: SUCCESS — state.predicate flipped to recipient`,
      );
      return 'resolved';
    } catch (err) {
      logger.debug(
        'Payments',
        `[LOCAL-FINALIZE] ${tokenId.slice(0, 16)}: finalize threw (${err instanceof Error ? err.message : String(err)}) — staying pending for retry`,
      );
      return 'failed';
    }
  }

  private async resolveLegacyReceivedToken(
    tokenId: string,
    _token: Token,
  ): Promise<'resolved' | 'stillPending' | 'failed'> {
    const job = this.proofPollingJobs.get(tokenId);
    if (!job || !job.sourceTokenJson) {
      // No job: stranded (#144 L3 migration handles via
      // recoverStrandedReceivedTokens at load time). Don't fail here —
      // just report stillPending so the periodic retry stays calm.
      return 'stillPending';
    }

    // Steelman FIX D (#144): recovery jobs (registered by
    // `recoverStrandedReceivedTokens`) carry `commitmentJson: ''` — we
    // can't reconstruct the sender's authenticator, so the polling queue
    // uses the `getProof(requestIdHex)` fallback for them. Mirror that
    // here. Pre-FIX-D, `JSON.parse('')` threw, the outer catch swallowed
    // it, and this 10s defense-in-depth retry was a silent no-op for the
    // exact migration scenario it was meant to cover.
    if (!job.commitmentJson) {
      return await this.resolveLegacyReceivedTokenViaGetProof(tokenId, job);
    }

    try {
      const commitmentInput = JSON.parse(job.commitmentJson);
      const commitment = await TransferCommitment.fromJSON(commitmentInput);

      if (!this.deps!.oracle.waitForProofSdk) {
        // Can't poll for proof; rely on the background queue and any
        // explicit finalize callers (already handled in finalizeReceivedToken).
        return 'stillPending';
      }

      // Short timeout — resolveUnconfirmed is called every 10s; we don't
      // want to block other tokens in the loop.
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 500);
      let inclusionProof: unknown = null;
      try {
        inclusionProof = await Promise.race([
          this.deps!.oracle.waitForProofSdk(commitment, abortController.signal),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
        ]);
      } catch {
        // Aggregator timeout / no proof yet — let the next tick try again.
        clearTimeout(timeoutId);
        return 'stillPending';
      }
      clearTimeout(timeoutId);

      if (!inclusionProof) return 'stillPending';

      // Proof landed — finalize. `finalizeReceivedToken` writes through to
      // `this.tokens` and persists via `save()`. It also emits the
      // `transfer:confirmed` event.
      let sourceTokenInput: unknown;
      try {
        sourceTokenInput = JSON.parse(job.sourceTokenJson);
      } catch (err) {
        logger.error(
          'Payments',
          `[V6-RESOLVE] Failed to parse stored sourceTokenJson for ${tokenId.slice(0, 12)}:`,
          err,
        );
        return 'failed';
      }
      await this.finalizeReceivedToken(tokenId, sourceTokenInput, commitmentInput);

      // Clean up the proof-polling job — finalizeReceivedToken doesn't
      // remove it (the background queue normally does). Persist the
      // updated map.
      this.proofPollingJobs.delete(tokenId);
      this.saveProofPollingJobs().catch((err) =>
        logger.debug('Payments', '[V6-PERSIST] saveProofPollingJobs after resolve failed:', err),
      );

      return 'resolved';
    } catch (err) {
      logger.debug(
        'Payments',
        `[V6-RESOLVE] Error resolving legacy receive ${tokenId.slice(0, 12)}: ${(err as Error)?.message ?? err}`,
      );
      return 'stillPending';
    }
  }

  /**
   * #144 L3 + steelman FIX D — defense-in-depth retry for recovery jobs
   * (registered by `recoverStrandedReceivedTokens`). Uses
   * `getProof(requestIdHex)` since we don't have a `TransferCommitment`
   * for reconstructed jobs. On success, hands off to
   * `finalizeStrandedReceivedToken` which patches the inclusion proof
   * into the source TXF and finalizes.
   */
  private async resolveLegacyReceivedTokenViaGetProof(
    tokenId: string,
    job: ProofPollingJob,
  ): Promise<'resolved' | 'stillPending' | 'failed'> {
    try {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 500);
      let proofResult: unknown = null;
      try {
        proofResult = await Promise.race([
          this.deps!.oracle.getProof(job.requestIdHex),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
        ]);
      } catch {
        clearTimeout(timeoutId);
        return 'stillPending';
      }
      clearTimeout(timeoutId);
      if (!proofResult) return 'stillPending';

      // The recovery callback (`finalizeStrandedReceivedToken`) does the
      // actual patch+finalize using `sourceTokenJson` + the cached
      // lastTxJson it closed over at registration time. Don't reimplement
      // that here — just invoke the callback.
      if (!job.onProofReceived) return 'failed';
      await job.onProofReceived(tokenId);

      // Clean up; `finalizeStrandedReceivedToken` doesn't remove the job.
      this.proofPollingJobs.delete(tokenId);
      this.saveProofPollingJobs().catch((err) =>
        logger.debug('Payments', '[V6-PERSIST] saveProofPollingJobs after recovery resolve failed:', err),
      );
      return 'resolved';
    } catch (err) {
      logger.debug(
        'Payments',
        `[V6-RESOLVE] Error resolving recovery job ${tokenId.slice(0, 12)}: ${(err as Error)?.message ?? err}`,
      );
      return 'stillPending';
    }
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

    const dedupKey = computeHistoryDedupKey(
      entry.type,
      entry.tokenId,
      entry.transferId,
      entry.coinId,
    );
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
            dedupKey:
              e.dedupKey ||
              computeHistoryDedupKey(e.type, e.tokenId, e.transferId, e.coinId),
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
   * Get the active nametag entry — the one whose name matches
   * `identity.nametag` (the name advertised on Nostr). Falls back to
   * `nametags[0]` when the claim is unset or has no matching entry, so
   * legacy single-nametag callers see no behavior change.
   *
   * The preference matters for PROXY-mode finalize: it must derive the
   * recipient address from the token whose name matches Nostr,
   * otherwise inbound transfers to `@claimed` (PROXY computed from
   * `TokenId.fromNameTag('claimed')`) are rejected against the
   * `[0]` entry's tokenId.
   *
   * @returns The active nametag data, or `null` if no nametag is set.
   */
  getNametag(): NametagData | null {
    const claimedName = this.deps?.identity.nametag;
    if (claimedName) {
      const match = this.nametags.find((n) => n.name === claimedName);
      if (match) return match;
    }
    return this.nametags[0] ?? null;
  }

  /**
   * Look up a stored nametag entry by exact name. Returns `null` if the
   * wallet hasn't minted (or hasn't loaded a token for) this name.
   *
   * Used by `Sphere.registerNametag` to detect the "mint already done for
   * THIS specific name" idempotency case (vs. "some OTHER nametag is
   * minted") so the consistency guard fires correctly.
   *
   * @param name - Normalized nametag name (e.g. result of `normalizeNametag`).
   */
  getNametagByName(name: string): NametagData | null {
    return this.nametags.find((n) => n.name === name) ?? null;
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
   * Check whether ANY nametag is currently set.
   *
   * Prefer {@link hasNametagNamed} when the caller cares about a specific
   * name (e.g. the `registerNametag` consistency guard) — `hasNametag()`
   * alone returns true for any stored entry regardless of name, which was
   * the source of the alice-vs-alice-t1 Nostr-vs-on-chain inconsistency
   * bug.
   *
   * @returns `true` if nametag data is present.
   */
  hasNametag(): boolean {
    return this.nametags.length > 0;
  }

  /**
   * Check whether a nametag with this exact name is stored.
   *
   * @param name - Normalized nametag name.
   */
  hasNametagNamed(name: string): boolean {
    return this.nametags.some((n) => n.name === name);
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
   * Remove a single nametag entry (by exact name) from local state. The
   * on-chain token IS NOT burned — this only forgets the local pointer.
   *
   * Used by `Sphere.registerNametag` to roll back an orphaned mint when
   * the subsequent Nostr-binding publish fails: the mint succeeded
   * (on-chain anchor exists under this wallet's pubkey), but the public
   * claim couldn't be made, so we drop the local reference rather than
   * leaving a dangling token that confuses subsequent `registerNametag`
   * attempts (they would otherwise hit `NAMETAG_CONFLICT`).
   *
   * @param name - Normalized nametag name (e.g. result of `normalizeNametag`).
   * @returns `true` if an entry was removed, `false` if no matching entry existed.
   */
  async clearNametagByName(name: string): Promise<boolean> {
    this.ensureInitialized();
    const before = this.nametags.length;
    this.nametags = this.nametags.filter((n) => n.name !== name);
    const removed = this.nametags.length < before;
    if (removed) {
      await this.save();
    }
    return removed;
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
   * Mint a fungible token directly to this wallet (genesis mint).
   *
   * Useful for test setups that need to seed a wallet with specific token
   * balances WITHOUT depending on the testnet faucet HTTP service. The
   * resulting token has the canonical CoinId bytes (passed in `coinIdHex`)
   * — when those bytes match a registered symbol in the TokenRegistry,
   * the token shows up under the symbol's name (e.g. "UCT"). There is no
   * cryptographic restriction on which key may issue a given CoinId; the
   * aggregator records the mint regardless of issuer identity.
   *
   * The flow:
   *   1. Generate a random TokenId.
   *   2. Build TokenCoinData with [(coinId, amount)].
   *   3. Build MintTransactionData with recipient = self (UnmaskedPredicate
   *      from this wallet's signing service).
   *   4. Submit MintCommitment to the aggregator.
   *   5. Wait for the inclusion proof.
   *   6. Construct an SDK Token via Token.mint().
   *   7. Convert to wallet Token format and call addToken().
   *
   * @param coinIdHex - 64-char lowercase hex CoinId. Must match the bytes
   *   used by the registered symbol if you want the wallet to recognize
   *   the token as that symbol (e.g. UCT's coinId from the public registry).
   * @param amount - Amount in smallest units (multiply by 10^decimals
   *   when converting from human values).
   * @returns Result with the resulting wallet Token and its on-chain id.
   */
  async mintFungibleToken(
    coinIdHex: string,
    amount: bigint,
  ): Promise<{ success: true; token: Token; tokenId: string } | { success: false; error: string }> {
    this.ensureInitialized();

    const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
    if (!stClient) {
      return { success: false, error: 'State transition client not available' };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trustBase = (this.deps!.oracle as any).getTrustBase?.();
    if (!trustBase) {
      return { success: false, error: 'Trust base not available' };
    }

    try {
      const signingService = await this.createSigningService();
      const { TokenId } = await import('@unicitylabs/state-transition-sdk/lib/token/TokenId');
      const { TokenCoinData } = await import('@unicitylabs/state-transition-sdk/lib/token/fungible/TokenCoinData');
      const { UnmaskedPredicateReference } = await import('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference');

      // Use the same token-type prefix the wider SDK uses for fungible
      // genesis (see InvoiceTokenType / NametagMinter conventions). This
      // keeps the sdkData shape compatible with the rest of PaymentsModule.
      const tokenTypeBytes = fromHex('f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509');
      const tokenType = new TokenType(tokenTypeBytes);

      // Random tokenId — each mint produces a unique token.
      const tokenIdBytes = new Uint8Array(32);
      crypto.getRandomValues(tokenIdBytes);
      const tokenId = new TokenId(tokenIdBytes);

      const coinIdBytes = fromHex(coinIdHex);
      const coinId = new CoinId(coinIdBytes);
      const coinData = TokenCoinData.create([[coinId, amount]]);

      // Recipient = self via UnmaskedPredicateReference → DirectAddress.
      const addressRef = await UnmaskedPredicateReference.create(
        tokenType,
        signingService.algorithm,
        signingService.publicKey,
        HashAlgorithm.SHA256,
      );
      const ownerAddress = await addressRef.toAddress();

      // Random salt — uniqueness gate for the mint commitment.
      const salt = new Uint8Array(32);
      crypto.getRandomValues(salt);

      const mintData = await MintTransactionData.create(
        tokenId,
        tokenType,
        null,            // tokenData: no metadata
        coinData,        // fungible coin data
        ownerAddress,    // recipient = self
        salt,
        null,            // recipientDataHash
        null,            // reason: null (genesis, no burn predecessor)
      );

      const commitment = await MintCommitment.create(mintData);

      // Submit with retry — REQUEST_ID_EXISTS counts as success (idempotent).
      const MAX_RETRIES = 3;
      let lastStatus: string | undefined;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const response = await stClient.submitMintCommitment(commitment);
        lastStatus = response.status;
        if (response.status === 'SUCCESS' || response.status === 'REQUEST_ID_EXISTS') break;
        if (attempt === MAX_RETRIES) {
          return { success: false, error: `Mint submit failed after ${MAX_RETRIES} attempts: ${response.status}` };
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
      if (lastStatus !== 'SUCCESS' && lastStatus !== 'REQUEST_ID_EXISTS') {
        return { success: false, error: `Mint submit failed: ${lastStatus}` };
      }

      const inclusionProof = await waitInclusionProof(trustBase, stClient, commitment);
      const genesisTransaction = commitment.toTransaction(inclusionProof);

      // Build the token state with an UnmaskedPredicate so this wallet
      // owns the token (predicate verification matches signingService).
      const predicate = await UnmaskedPredicate.create(
        tokenId,
        tokenType,
        signingService,
        HashAlgorithm.SHA256,
        salt,
      );
      const tokenState = new TokenState(predicate, null);
      const sdkToken = await SdkToken.mint(trustBase, tokenState, genesisTransaction);

      // Convert to wallet Token and add it. addToken does the persistence
      // + cache + tombstone bookkeeping.
      const tokenIdHex = tokenId.toJSON();
      const symbol = this.getCoinSymbol(coinIdHex);
      const name = this.getCoinName(coinIdHex);
      const decimals = this.getCoinDecimals(coinIdHex);
      const iconUrl = this.getCoinIconUrl(coinIdHex);
      const uiToken: Token = {
        id: tokenIdHex,
        coinId: coinIdHex,
        symbol,
        name,
        decimals,
        ...(iconUrl !== undefined ? { iconUrl } : {}),
        amount: amount.toString(),
        status: 'confirmed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        sdkData: JSON.stringify(sdkToken.toJSON()),
      };
      await this.addToken(uiToken);

      return { success: true, token: uiToken, tokenId: tokenIdHex };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: `Local mint failed: ${msg}` };
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
   * Drain semantics: when at least one token-storage provider is configured,
   * `sync()` first drains pending V5 finalizations (default-on, capped at
   * `drainTimeoutMs`) so the published CAR is a complete inventory. Without
   * draining, `tokenToTxf()` returns null for any token whose `sdkData`
   * still carries `_pendingFinalization`, and `buildTxfStorageData()`
   * silently drops it from the CAR — a remote device's `recoverLatest()`
   * would then walk to the higher pointer and observe a partial inventory.
   * If the drain times out (some tokens still pending), the flush is
   * skipped (no partial CAR is published) — set
   * `forceFlushOnDrainTimeout: true` to override.
   *
   * @param options - Optional sync options (drain control, timeouts).
   * @returns Sync result with added/removed counts plus drain status.
   */
  async sync(options?: SyncOptions): Promise<SyncResult> {
    this.ensureInitialized();

    // Sync coalescing: if a sync is already in progress, return its promise.
    // This prevents race conditions when a remote-update event triggers a
    // fire-and-forget sync and the caller also syncs immediately after.
    // The first call's options win for the in-flight operation.
    if (this._syncInProgress) {
      return this._syncInProgress;
    }

    this._syncInProgress = this._doSync(options);
    try {
      return await this._syncInProgress;
    } finally {
      this._syncInProgress = null;
    }
  }

  private async _doSync(options?: SyncOptions): Promise<SyncResult> {
    this.deps!.emitEvent('sync:started', { source: 'payments' });

    try {
      // Get all token storage providers
      const providers = this.getTokenStorageProviders();

      if (providers.size === 0) {
        // No providers - just save locally. No draining: save() goes to
        // the kv StorageProvider which preserves _pendingFinalization
        // shape, so dropping pending tokens is not an issue here.
        await this.save();
        this.deps!.emitEvent('sync:completed', {
          source: 'payments',
          count: this.tokens.size,
        });
        return { added: 0, removed: 0 };
      }

      // Drain pending V5 finalizations BEFORE serializing localData via
      // tokenToTxf. Default-on; opt out via `drainPending: false`.
      const drainPending = options?.drainPending ?? true;
      if (drainPending) {
        const drain = await this.drainPendingFinalizations({
          timeoutMs: options?.drainTimeoutMs ?? 30_000,
          pollIntervalMs: options?.drainPollIntervalMs ?? 2_000,
        });
        if (drain.timedOut && !drain.skipped) {
          // Drain ran but didn't finish in time. Count residual pending.
          const pendingAtFlush = Array.from(this.tokens.values()).filter(
            (t) => t.status === 'submitted' || t.status === 'pending',
          ).length;
          // DEFAULT-FLUSH (per user requirement): we MUST publish
          // unconfirmed tokens to IPFS so that on profile loss,
          // recovery picks them up and the load-time
          // `tryLocalFinalizeUnconfirmed` flow attempts re-finalization.
          // Previously this defaulted to "skip flush to avoid partial
          // CAR" — but that left unfinalized tokens un-recoverable
          // (Nostr-only delivery, so a wipe + re-import after the
          // sender's outbox aged out lost the funds entirely).
          //
          // Opt OUT explicitly via `forceFlushOnDrainTimeout: false`
          // when the caller wants the pre-existing skip-flush
          // behaviour (e.g. test scenarios that depend on
          // determinism). The default is to publish — tokens that
          // are still pending land in the CAR with their current
          // sdkData (sender's state.predicate). The recipient device
          // (or a recovered profile) then runs
          // `tryLocalFinalizeUnconfirmed` to apply the transition
          // locally using the on-disk proof, flipping state.predicate
          // to its own signing key.
          const forceFlush = options?.forceFlushOnDrainTimeout ?? true;
          if (!forceFlush) {
            logger.warn(
              'Payments',
              `sync: drain timed out with ${pendingAtFlush} token(s) still pending V5 finalization — skipping flush (forceFlushOnDrainTimeout=false) to avoid partial CAR. Retry sync() once finalization completes.`,
            );
            this.deps!.emitEvent('sync:completed', {
              source: 'payments',
              count: this.tokens.size,
            });
            return { added: 0, removed: 0, drainTimedOut: true, pendingAtFlush };
          }
          logger.warn(
            'Payments',
            `sync: drain timed out with ${pendingAtFlush} token(s) still pending V5 finalization — flushing anyway (default: publish unfinalized state for recovery). The recipient/recovered profile will re-attempt local finalization on load.`,
          );
        }
      }

      // Create local data once
      const localData = await this.createStorageData();

      let totalAdded = 0;
      let totalRemoved = 0;

      // Sync with each provider. Nametag preservation when merged data
      // omits `_nametags` is handled inside `loadFromStorageData` (#136).
      for (const [providerId, provider] of providers) {
        try {
          const result = await provider.sync(localData);

          if (result.success && result.merged) {
            // Address guard: reject data from a different address.
            // Stale IPFS records may contain tokens from a previously active
            // address if a write-behind flush raced with an address switch.
            //
            // Accept three representations (one per writer):
            //   - L1 bech32 (`alpha1...`) — legacy file storage writes this
            //   - chain pubkey — some providers record the pubkey
            //   - Profile short ID (`DIRECT_{first6}_{last6}`) — written by
            //     ProfileTokenStorageProvider via `computeAddressId`
            //
            // The third format was added to `load()`'s guard but missed
            // here, causing sync() to silently discard Profile-provider
            // data on cross-device recovery — Device B reads Device A's
            // CAR via the aggregator pointer, the parsed `_meta.address`
            // is the DIRECT_* short-id, and `currentL1` is the bech32
            // form. Mismatch → reject → recovery returns empty.
            const mergedMeta = (result.merged as TxfStorageDataBase)?._meta;
            const currentL1 = this.deps!.identity.l1Address;
            const currentChain = this.deps!.identity.chainPubkey;
            const currentDirect = this.deps!.identity.directAddress;
            const currentProfileShortId = currentDirect ? computeAddressId(currentDirect) : null;
            if (
              mergedMeta?.address &&
              mergedMeta.address !== currentL1 &&
              mergedMeta.address !== currentChain &&
              mergedMeta.address !== currentProfileShortId
            ) {
              const accepted = [
                currentL1 ? `L1=${currentL1.slice(0, 16)}…` : null,
                currentChain ? `chain=${currentChain.slice(0, 16)}…` : null,
                currentProfileShortId ? `profile=${currentProfileShortId}` : null,
              ].filter(Boolean).join(', ');
              logger.warn(
                'Payments',
                `Sync: rejecting data from provider ${providerId} — address mismatch (got=${mergedMeta.address.slice(0, 24)} accepted=[${accepted}])`,
              );
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

      // Surface any tokens that rode through the flush in pending-V5 state
      // so callers can detect partial-CAR risk (relevant when drain was
      // skipped due to no oracle, OR forceFlushOnDrainTimeout overrode a
      // timed-out drain). Successful drain → pendingAtFlush = 0 → omit
      // from the result.
      const pendingAtFlush = Array.from(this.tokens.values()).filter(
        (t) => t.status === 'submitted' || t.status === 'pending',
      ).length;
      const result: SyncResult = { added: totalAdded, removed: totalRemoved };
      if (pendingAtFlush > 0) result.pendingAtFlush = pendingAtFlush;
      return result;
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
  // SENT history recording (shared by both UXF dispatchers)
  // ===========================================================================

  /**
   * Record SENT history entries for a UXF bundle, one per coin involved.
   *
   * #149 multi-coin follow-up: pre-fix, the UXF dispatchers wrote a single
   * SENT history entry tagged with the primary coin only — any additional
   * coins shipped in the same bundle silently disappeared from history.
   * This helper emits one entry per coin (primary + each additionalAssets
   * coin), each tagged with that coin's id/symbol/amount and the
   * per-coin tokenIds breakdown.
   *
   * `result.tokens` carries the consumed source tokens (with their
   * pre-burn `coinId`); `result.tokenTransfers` enumerates per-source
   * commits (`split` or `direct`). We pivot tokenTransfers by source
   * coinId to populate each entry's `tokenIds` array.
   *
   * NFT additional assets are intentionally skipped — they're whole-token
   * transfers (no fungible amount) and need separate history schema work;
   * tracked as a follow-up.
   *
   * Failure handling: storage I/O hiccup must not turn a successful send
   * into a thrown error. Each entry is wrapped in its own try/catch so
   * one bad write can't drop the rest.
   */
  private async recordUxfBundleSentHistory(args: {
    originalRequest: TransferRequest;
    request: LegacyCoinTransferRequest;
    result: TransferResult;
    peerInfo: PeerInfo | null;
    recipientPubkey: string;
    recipientAddress: { toString(): string };
    diagLabel: string;
  }): Promise<void> {
    const {
      originalRequest,
      request,
      result,
      peerInfo,
      recipientPubkey,
      recipientAddress,
      diagLabel,
    } = args;

    const recipientNametag =
      peerInfo?.nametag ??
      (originalRequest.recipient.startsWith('@')
        ? originalRequest.recipient.slice(1)
        : undefined);

    // Pivot tokenTransfers by source coinId. result.tokens carries the
    // consumed source tokens (post-removal from in-memory map, but still
    // present on the result). For each source, look up its pre-burn
    // coinId and amount.
    const tokenMap = new Map(result.tokens.map((t) => [t.id, t]));
    const perCoinTokenIds = new Map<
      string,
      Array<{ id: string; amount: string; source: 'split' | 'direct' }>
    >();
    for (const tt of result.tokenTransfers) {
      const tok = tokenMap.get(tt.sourceTokenId);
      if (!tok) continue;
      const list = perCoinTokenIds.get(tok.coinId) ?? [];
      list.push({
        id: tt.sourceTokenId,
        amount: tok.amount,
        source: tt.method === 'split' ? 'split' : 'direct',
      });
      perCoinTokenIds.set(tok.coinId, list);
    }

    // Build the per-coin summary list. Primary slot first; then each
    // additionalAssets coin entry preserving caller order. NFT
    // additionals are excluded (whole-token, no amount slot).
    type CoinSummary = { coinId: string; amount: string };
    const summaries: CoinSummary[] = [
      { coinId: request.coinId, amount: request.amount },
    ];
    for (const asset of originalRequest.additionalAssets ?? []) {
      if (asset.kind !== 'coin') continue;
      summaries.push({ coinId: asset.coinId, amount: asset.amount });
    }

    const recipientAddressStr =
      peerInfo?.directAddress ?? recipientAddress.toString() ?? recipientPubkey;

    const baseTimestamp = Date.now();
    for (const summary of summaries) {
      const tokenIds = perCoinTokenIds.get(summary.coinId) ?? [];
      const firstTokenId = tokenIds[0]?.id;
      try {
        await this.addToHistory({
          type: 'SENT',
          amount: summary.amount,
          coinId: summary.coinId,
          symbol: this.getCoinSymbol(summary.coinId),
          timestamp: baseTimestamp,
          recipientPubkey,
          ...(recipientNametag !== undefined ? { recipientNametag } : {}),
          recipientAddress: recipientAddressStr,
          ...(request.memo !== undefined ? { memo: request.memo } : {}),
          transferId: result.id,
          ...(firstTokenId !== undefined ? { tokenId: firstTokenId } : {}),
          ...(tokenIds.length > 0 ? { tokenIds } : {}),
        });
      } catch (err) {
        logger.warn(
          'Payments',
          `${diagLabel}: failed to record SENT history for coin=${summary.coinId.slice(
            0,
            16,
          )} (send already succeeded): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
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

    // Loop1-S9 — every token selectSources marked `transferring` is
    // pushed here so the outer catch can restore non-committed
    // sources back to `confirmed` on failure (mirrors the instant
    // dispatcher pattern).
    const dispatcherSelectedTokenIds: string[] = [];

    // Loop1-S7 + Loop2-W3 — track every reservation id (primary +
    // per-additional-asset queue id) so we can commit/cancel each
    // one at the end. Without this, multi-coin sends leak per-coin
    // ledger entries. Initialize empty — the conservative dispatcher
    // does NOT pass `transferId` itself to planSend (it uses
    // `${transferId}:${coinId}[:${i}]` keys); committing the bare
    // transferId was a silent no-op against ReservationLedger.
    const reservationIds: string[] = [];

    const deps: ConservativeSenderDeps = {
      aggregator: this.deps!.oracle,
      transport: this.deps!.transport,
      tokenStorage: null,
      identity: this.deps!.identity,
      senderTransportPubkey: this.deps!.identity.chainPubkey,
      emit: (type, data) => this.deps!.emitEvent(type, data),
      // Issue #200 Phase 1 wiring: when the host injected a
      // `publishToIpfs` callback into `PaymentsModuleDependencies`,
      // pass it through to the conservative sender so CID-bound
      // delivery branches (`force-cid`, over-cap `auto`) actually pin.
      // When absent, the sender falls back to inline delivery or
      // throws `IPFS_PUBLISHER_REQUIRED` per the resolver contract.
      // The callback MUST be obtained from `createUxfCarPublisher`
      // (see `./transfer/ipfs-publisher.ts`) — any other publisher
      // breaks the CID-correspondence contract.
      publishToIpfs: this.deps!.publishToIpfs,
      availableSources: () => Array.from(this.tokens.values()),
      transferId,
      selectSources: async ({ request: req }) => {
        // #142/#149 — return the structured ConservativeSourceSelection
        // shape with `splitSources` (array). Primary coin's split (if
        // needed) is the first entry; each additional-asset coin that
        // also needs splitting becomes its own entry. NFT additional
        // assets and direct-only sources go into `directSources`.
        const directSources: Token[] = [];
        const splitSources: Array<NonNullable<ConservativeSourceSelection['splitSources']>[number]> = [];

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
        reservationIds.push(primaryQueueId);
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
        directSources.push(...splitPlan.tokensToTransferDirectly.map((t) => t.uiToken));

        if (splitPlan.tokenToSplit) {
          // Loop1-S2 — defensive guard, mirrors the instant dispatcher.
          // A planner bug that returns tokenToSplit with null/zero
          // splitAmount would burn the source for nothing.
          if (
            splitPlan.splitAmount === null ||
            splitPlan.remainderAmount === null ||
            splitPlan.splitAmount <= 0n
          ) {
            throw new SphereError(
              `dispatchUxfConservativeSend: planner returned tokenToSplit with null/zero splitAmount=${String(splitPlan.splitAmount)} / remainderAmount=${String(splitPlan.remainderAmount)} for primary coinId=${request.coinId.slice(0, 16)}; refusing to burn source for zero-coin recipient`,
              'INVALID_CONFIG',
            );
          }
          splitSources.push({
            token: splitPlan.tokenToSplit.uiToken,
            splitAmount: splitPlan.splitAmount,
            remainderAmount: splitPlan.remainderAmount,
            coinIdHex: request.coinId,
          });
        }

        // ── Additional assets (coin entries only) ─────────────────────────────
        // #149 — each additional coin that needs splitting becomes its
        // own `splitSources` entry. Each is planned independently with
        // a unique queue id (${transferId}:${addCoinId}:${i}) to prevent
        // promise-map collisions when two entries queue for the same
        // SpendQueue.
        const additional = req.additionalAssets ?? [];
        for (let i = 0; i < additional.length; i++) {
          const asset = additional[i];
          if (asset.kind !== 'coin') continue; // NFT: whole-token, handled by commitSources
          const addCoinId = asset.coinId;
          // #149 invariant — duplicate coinIds (primary or earlier
          // additional) are a user-input bug. The send() validator
          // upstream should catch this, but defense-in-depth here
          // protects against the contract violation: orchestrator
          // would otherwise reject in its splitSources guard.
          if (addCoinId === request.coinId) {
            throw new SphereError(
              `dispatchUxfConservativeSend: additionalAssets[${i}].coinId duplicates primary coinId=${addCoinId.slice(0, 16)}; ` +
                'combine the amounts into the primary slot instead',
              'INVALID_CONFIG',
            );
          }
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
          reservationIds.push(addQueueId);
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
          directSources.push(...addSplitPlan.tokensToTransferDirectly.map((t) => t.uiToken));
          if (addSplitPlan.tokenToSplit) {
            // #149 — additional-asset split. Same defensive guard as
            // the primary coin path: null/zero splitAmount means a
            // planner bug; refuse to burn for zero-coin recipient.
            if (
              addSplitPlan.splitAmount === null ||
              addSplitPlan.remainderAmount === null ||
              addSplitPlan.splitAmount <= 0n
            ) {
              throw new SphereError(
                `dispatchUxfConservativeSend: planner returned tokenToSplit with null/zero splitAmount=${String(addSplitPlan.splitAmount)} / remainderAmount=${String(addSplitPlan.remainderAmount)} for additional coinId=${addCoinId.slice(0, 16)}; refusing to burn source for zero-coin recipient`,
                'INVALID_CONFIG',
              );
            }
            splitSources.push({
              token: addSplitPlan.tokenToSplit.uiToken,
              splitAmount: addSplitPlan.splitAmount,
              remainderAmount: addSplitPlan.remainderAmount,
              coinIdHex: addCoinId,
            });
          }
        }

        // [DIAG-UXF-SEND] all sources selected across primary + additionalAssets
        logger.debug('Payments', '[DIAG-UXF-SEND] selectSources result', {
          totalDirect: directSources.length,
          splitCount: splitSources.length,
          directIds: directSources.map((t) => `${t.id.slice(0, 12)}(${t.coinId.slice(0, 12)})`),
          splitIds: splitSources.map(
            (s) => `${s.token.id.slice(0, 12)}(${s.coinIdHex.slice(0, 12)}:${s.splitAmount.toString()})`,
          ),
          primaryCoinId: request.coinId.slice(0, 16),
          additionalCount: (req.additionalAssets ?? []).filter((a) => a.kind === 'coin').length,
        });

        // Issue #166 P2 #2 — duplicate-bundle guard. Refuse to mark
        // sources as transferring if any planned token id is already
        // referenced by a live OUTBOX entry or recorded in the SENT
        // ledger. The check is best-effort: read failures degrade to
        // a warn-log (the natural `'transferring'`-status filter in
        // SpendPlanner.buildParsedPool stays as the load-bearing
        // defense). Throws BEFORE the mark loop so a violation leaves
        // sources in their original status — no rollback needed.
        await this.assertNoDuplicateBundleMembership(
          [
            ...directSources.map((t) => t.id),
            ...splitSources.map((e) => e.token.id),
          ],
          {
            opLabel: 'dispatchUxfConservativeSend',
            allowOverride: req.allowDuplicateBundleMembership === true,
          },
        );

        // Issue #197 — finalize EVERY pending tx in EVERY selected
        // source's chain BEFORE marking them transferring and BEFORE
        // bundle construction. A local `status === 'confirmed'` is
        // INDEPENDENT of `sdkData.transactions[*].inclusionProof`
        // completeness — a token can be locally confirmed (e.g. via
        // the recipient dispositionWriter fallback flip from Issue #195,
        // or an instant-mode arrival whose deferred worker never ran)
        // and still carry a proofless tx in its embedded chain. The
        // recipient's `Token.verify(trustBase)` would then reject the
        // bundle (because it walks EVERY tx in the chain) and silently
        // wedge the token after `SdkToken.fromJSON` throws on the null
        // proof.
        //
        // `finalizeSourceTokenChain` is the SOLE SDK routine that walks
        // an SDK Token chain and attaches aggregator proofs. It is
        // idempotent (returns the input reference unchanged when the
        // chain is already fully finalized — no allocation) and throws
        // `SOURCE_CHAIN_HARD_FAIL` only on irrecoverable failures
        // (race-lost, sustained PATH_NOT_INCLUDED, etc.) — the
        // orchestrator's catch path emits `transfer:failed`.
        //
        // Run BEFORE marking as transferring so a hard-fail here leaves
        // no stale `'transferring'` state to clean up. The SpendQueue
        // reservation remains held; existing throw points (e.g.
        // commitSources) have the same property.
        for (let i = 0; i < directSources.length; i++) {
          const finalized = await finalizeSourceTokenChain(
            directSources[i],
            this.deps!.oracle,
          );
          if (finalized !== directSources[i]) {
            directSources[i] = finalized;
            this.tokens.set(finalized.id, finalized);
            this.parsedTokenCache.delete(finalized.id);
          }
        }
        for (let i = 0; i < splitSources.length; i++) {
          const finalized = await finalizeSourceTokenChain(
            splitSources[i].token,
            this.deps!.oracle,
          );
          if (finalized !== splitSources[i].token) {
            splitSources[i] = { ...splitSources[i], token: finalized };
            this.tokens.set(finalized.id, finalized);
            this.parsedTokenCache.delete(finalized.id);
          }
        }

        // Mark all selected sources as transferring + persist (matches legacy
        // semantics — prevents double-spend within the same session).
        for (const tok of directSources) {
          tok.status = 'transferring';
          this.tokens.set(tok.id, tok);
          this.parsedTokenCache.delete(tok.id);
          dispatcherSelectedTokenIds.push(tok.id);
        }
        for (const entry of splitSources) {
          entry.token.status = 'transferring';
          this.tokens.set(entry.token.id, entry.token);
          this.parsedTokenCache.delete(entry.token.id);
          dispatcherSelectedTokenIds.push(entry.token.id);
        }
        await this.save();
        return { directSources, splitSources };
      },
      preflightOptions: () => ({
        // Issue #197 — chain finalization happens earlier in
        // `selectSources` via the standard `finalizeSourceTokenChain`
        // helper, which returns NEW Token objects that the orchestrator
        // then passes to commitSources. Doing the work there (rather
        // than via the preflight callback hooks) avoids fighting the
        // `Token.sdkData` readonly contract and keeps a single SDK
        // routine — `finalizeSourceTokenChain` — as the sole place
        // that walks a chain and attaches aggregator proofs.
        //
        // Preflight is therefore a documented no-op here. If
        // `selectSources` ever regresses (or a future code path skips
        // it and routes through this orchestrator directly), the
        // recipient's `Token.verify(trustBase)` will reject the
        // bundle and the operator alert below catches it.
        resolveRequestId: () => {
          throw new SphereError(
            'preflight resolveRequestId invoked unexpectedly — ' +
              'selectSources should have already finalized all source chains via finalizeSourceTokenChain',
            'INVALID_CONFIG',
          );
        },
        extractPendingChain: () => [],
      }),
      commitSources: async ({ sources, splitSources }) => {
        // [DIAG-UXF-SEND] how many source tokens are being committed?
        logger.debug('Payments', '[DIAG-UXF-SEND] commitSources entry', {
          sourceCount: sources.length,
          sourceIds: sources.map((t) => `${t.id.slice(0, 12)}(${t.coinId.slice(0, 12)})`),
          splitCount: splitSources?.length ?? 0,
        });
        const out: ConservativeCommitResult[] = [];

        // #149 — build a tokenId → split entry lookup so the source-
        // iteration loop can branch in O(1). Orchestrator already
        // validated tokenId uniqueness.
        const splitEntryByTokenId = new Map<
          string,
          NonNullable<ConservativeSourceSelection['splitSources']>[number]
        >();
        for (const entry of splitSources ?? []) {
          splitEntryByTokenId.set(entry.token.id, entry);
        }

        for (const token of sources) {
          // #142/#149 — split path. The previous implementation
          // discarded the split intent and whole-token-transferred the
          // source. The fix routes EACH split source through
          // TokenSplitExecutor (one invocation per entry) which burns
          // the source, mints two new tokens (splitAmount for recipient,
          // remainderAmount for sender), and transfers the recipient
          // slice with full proofs (conservative semantics).
          const splitEntry = splitEntryByTokenId.get(token.id);
          if (splitEntry !== undefined) {
            if (!token.sdkData || typeof token.sdkData !== 'string') {
              throw new SphereError(
                `Split source token ${token.id} missing sdkData`,
                'TRANSFER_FAILED',
              );
            }
            const sdkSourceToken = await SdkToken.fromJSON(JSON.parse(token.sdkData));
            const splitExecutor = new TokenSplitExecutor({
              stateTransitionClient: stClient,
              trustBase,
              signingService,
            });

            // Loop2-C2 — burn-then-tombstone via try/finally. The
            // onBurnSubmitted callback fires from inside executeSplit
            // the moment the burn is durable on-chain (after submit
            // response, before proof wait). Any subsequent throw
            // (waitInclusionProof timeout, mint submit failure, etc.)
            // still leaves the source on-chain spent → must be
            // tombstoned locally regardless. The finally fires
            // removeToken if `burnDone` is true.
            let burnDone = false;
            try {
              const splitResult = await splitExecutor.executeSplit(
                sdkSourceToken,
                splitEntry.splitAmount,
                splitEntry.remainderAmount,
                splitEntry.coinIdHex,
                recipientAddress,
                onChainMessage,
                // CONTRACT (Loop3-W3): this callback MUST NOT THROW.
                // The executor swallows any throw, but a throw here
                // would desync `burnDone` from the on-chain reality
                // → phantom token. Keep this Set.add + primitive
                // assignment only.
                () => {
                  burnDone = true;
                  committedOnChainTokenIds.add(token.id);
                },
              );

              // Persist the change token (remainderAmount, sender-keyed).
              // #149 — use splitEntry.coinIdHex (NOT request.coinId)
              // because additional-asset splits change-mint into the
              // additional coin's class, not the primary coin's.
              const changeCoinId = splitEntry.coinIdHex;
              const changeTokenData = splitResult.tokenForSender.toJSON();
              const changeUiToken: Token = {
                id: crypto.randomUUID(),
                coinId: changeCoinId,
                symbol: this.getCoinSymbol(changeCoinId),
                name: this.getCoinName(changeCoinId),
                decimals: this.getCoinDecimals(changeCoinId),
                iconUrl: this.getCoinIconUrl(changeCoinId),
                amount: splitEntry.remainderAmount.toString(),
                status: 'confirmed',
                createdAt: Date.now(),
                updatedAt: Date.now(),
                sdkData: JSON.stringify(changeTokenData),
              };
              await this.addToken(changeUiToken);
              logger.debug(
                'Payments',
                `dispatchUxfConservativeSend: change token persisted (coin=${changeCoinId.slice(0, 16)} amount=${changeUiToken.amount})`,
              );

              // Assemble the recipient SDK Token JSON: mint genesis + the
              // mint-time state, plus the post-mint transfer transaction
              // (both with proofs because conservative).
              const recipientTokenJson = splitResult.tokenForRecipient.toJSON() as Record<string, unknown>;
              const transferTxJson = splitResult.recipientTransferTx.toJSON();
              const composedRecipientJson = {
                ...recipientTokenJson,
                transactions: [
                  ...(((recipientTokenJson as { transactions?: unknown[] }).transactions) ?? []),
                  transferTxJson,
                ],
              };

              // Loop1-S1 — capture requestIdHex from the SplitResult's
              // pre-computed field. TransferTransaction has NO requestId;
              // SplitResult.recipientTransferRequestIdHex is captured from
              // the underlying TransferCommitment BEFORE toTransaction().
              const transferRequestIdHex = splitResult.recipientTransferRequestIdHex;

              out.push({
                sourceTokenId: token.id,
                method: 'split',
                requestIdHex: transferRequestIdHex,
                recipientTokenJson: composedRecipientJson,
                splitGroupId: crypto.randomUUID(),
              });
            } finally {
              if (burnDone) {
                try {
                  await this.removeToken(token.id, transferId);
                } catch (rmErr) {
                  logger.warn(
                    'Payments',
                    `dispatchUxfConservativeSend: removeToken(${token.id}) failed after burn — manual cleanup may be needed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
                  );
                }
              }
            }
            continue;
          }

          // Direct (whole-token) path — Loop2-C2 try/finally so
          // removeToken always fires once the on-chain commit is
          // durable, even if waitInclusionProof times out / throws or
          // the JSON construction breaks.
          const commitment = await this.createSdkCommitment(
            token,
            recipientAddress,
            signingService,
            onChainMessage,
          );
          // Item #14 Phase 1 — route through the classified-submit
          // helper so a "state already spent by another commit"
          // outcome surfaces as `STATE_ALREADY_SPENT_BY_OTHER` (the
          // outer catch emits `transfer:double-spend-detected`)
          // rather than the legacy generic `TRANSFER_FAILED`.
          await this.submitCommitmentClassified(
            stClient,
            this.deps?.oracle,
            commitment,
            {
              tokenId: token.id,
              intendedRecipient: originalRequest.recipient,
            },
          );
          let consDirectCommitted = false;
          try {
            consDirectCommitted = true;
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
            // Loop2-C3 — tighten requestIdHex extraction. RequestId
            // extends DataHash whose toJSON() returns a hex imprint.
            // Validate the shape; throw on SDK shape regression
            // instead of silently shipping garbage like
            // "[object Object]".
            const requestIdHexRaw = (commitment.requestId as { toJSON?: () => string })?.toJSON?.();
            if (typeof requestIdHexRaw !== 'string' || !/^[0-9a-f]+$/i.test(requestIdHexRaw)) {
              throw new SphereError(
                `dispatchUxfConservativeSend: commitment.requestId.toJSON() returned non-hex (${typeof requestIdHexRaw}); SDK shape regression?`,
                'TRANSFER_FAILED',
              );
            }
            const requestIdHex = requestIdHexRaw;
            out.push({
              sourceTokenId: token.id,
              method: 'direct',
              requestIdHex,
              recipientTokenJson,
            });
          } finally {
            if (consDirectCommitted) {
              try {
                await this.removeToken(token.id, transferId);
              } catch (rmErr) {
                logger.warn(
                  'Payments',
                  `dispatchUxfConservativeSend: removeToken(${token.id}) failed after on-chain commit — manual cleanup may be needed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
                );
              }
            }
          }
        }
        return out;
      },
      outbox: {
        // T.2.D.2 + Issue #97 — orchestrator drives §7.0 via create/
        // transition. Production wiring threads a profile-resident
        // OutboxWriter via {@link installOutboxWriter}. When installed:
        //   - create:      writer.write(entry); _senderOutboxMap mirror
        //                  is set in lock-step; legacy saveToOutbox is
        //                  also called so consumers reading the legacy
        //                  snapshot still observe the entry.
        //   - transition:  writer.update(...) gates the arc via the
        //                  §7.0 validator; mirror updates in lock-step;
        //                  on `'delivered'` the legacy entry is dropped
        //                  via removeFromOutbox AND the profile entry
        //                  is tombstoned via writer.delete.
        // When the writer is NULL (legacy mode / tests without profile
        // wiring), the hooks fold onto the legacy KV chain alone — the
        // pre-#97 behaviour is preserved.
        create: async (entry) => {
          const writer = this._outboxWriter;
          if (writer !== null) {
            // Durable profile write first — the in-memory mirror is
            // hydrated from this on next restart.
            const written = await writer.write(entry);
            this._senderOutboxMap.set(entry.id, written);
          }
          const synthResult: TransferResult = {
            id: entry.id,
            status: 'submitted',
            tokens: [],
            tokenTransfers: [],
          };
          await this.saveToOutbox(synthResult, entry.recipientTransportPubkey);
        },
        transition: async (id, patch) => {
          const writer = this._outboxWriter;
          let updated: UxfTransferOutboxEntry | null = null;
          if (writer !== null) {
            // Route through the writer so the §7.0 validator gates the
            // arc. The mutator folds the patch onto the previous entry.
            updated = await writer.update(id, (prev) => ({
              ...prev,
              status: patch.status,
              ...(typeof patch.error === 'string' ? { error: patch.error } : {}),
              ...(typeof patch.submitRetryCount === 'number'
                ? { submitRetryCount: patch.submitRetryCount }
                : {}),
              // Issue #166 P2 #3 — persist the Nostr event id when the
              // dispatcher supplies it (sending → delivered arc).
              ...(typeof patch.nostrEventId === 'string' &&
              patch.nostrEventId.length > 0
                ? { nostrEventId: patch.nostrEventId }
                : {}),
              updatedAt: Date.now(),
            }));
            this._senderOutboxMap.set(id, updated);
          }
          if (patch.status === 'delivered') {
            // Issue #97 — write the permanent SENT record BEFORE
            // tombstoning the outbox entry. Order matters: if SENT
            // write fails we MUST NOT tombstone, otherwise the
            // delivery becomes invisible to all forensic paths
            // (`removeToken` has already cleared the source token's
            // `'transferring'` status earlier in the conservative
            // pipeline, so the orphan-spending sweeper cannot help).
            //
            // Source of truth for the SENT shape is the in-memory
            // mirror entry (which was just updated above).
            const mirror = this._senderOutboxMap.get(id) ?? updated;
            const sentResult: 'success' | 'failed' | 'skipped' =
              mirror !== null
                ? await this.writeSentEntryFromOutbox(
                    mirror,
                    'dispatchUxfConservativeSend',
                  )
                : 'skipped';

            if (sentResult === 'failed') {
              // Steelman item 4 — keep the OUTBOX entry live at
              // status='delivered' as the forensic record so an
              // operator (or a future profile-level reconciliation
              // job) can re-attempt the SENT write. DO NOT tombstone
              // the profile entry. The legacy KV entry IS removed
              // (legacy outbox doesn't track 'delivered'), but the
              // profile entry persists — that's the load-bearing
              // signal.
              logger.warn(
                'Payments',
                `dispatchUxfConservativeSend: SENT write failed for ${id} — leaving profile OUTBOX entry live at status='delivered' for operator triage`,
              );
              try {
                await this.removeFromOutbox(id);
              } catch (legacyErr) {
                logger.warn(
                  'Payments',
                  `dispatchUxfConservativeSend: legacy removeFromOutbox(${id}) threw (non-fatal): ${legacyErr instanceof Error ? legacyErr.message : String(legacyErr)}`,
                );
              }
              // Intentionally NOT calling writer.delete here.
            } else {
              // 'success' OR 'skipped' (legacy mode) — proceed to
              // tombstone the profile entry AND drop the legacy KV
              // entry. The two drops are independently wrapped so a
              // throw in one doesn't skip the other.
              try {
                await this.removeFromOutbox(id);
              } catch (legacyErr) {
                logger.warn(
                  'Payments',
                  `dispatchUxfConservativeSend: legacy removeFromOutbox(${id}) threw (proceeding to profile tombstone): ${legacyErr instanceof Error ? legacyErr.message : String(legacyErr)}`,
                );
              }
              if (writer !== null) {
                try {
                  await writer.delete(id);
                  this._senderOutboxMap.delete(id);
                } catch (delErr) {
                  logger.warn(
                    'Payments',
                    `dispatchUxfConservativeSend: outboxWriter.delete(${id}) failed (profile entry left live at status='delivered'; operator-recoverable): ${delErr instanceof Error ? delErr.message : String(delErr)}`,
                  );
                }
              }
            }
          }
        },
      },
    };

    // Loop1-S7/S9 — wrap sendConservativeUxf with reservation
    // lifecycle + source restoration. The orchestrator does not roll
    // back source state on failure; the dispatcher owns the cleanup.
    let result: TransferResult;
    try {
      result = await sendConservativeUxf(originalRequest, recipient, deps);
      // Loop1-S7 + Loop3-W2 — commit every reservation id allocated
      // by selectSources (primary + per-additional-asset queue ids).
      // Wrap each in try/catch: ReservationLedger.commit is
      // currently non-throwing, but a future invariant assert
      // shouldn't leak the remaining commits.
      for (const rid of reservationIds) {
        try {
          this.reservationLedger.commit(rid);
        } catch (commitErr) {
          logger.warn(
            'Payments',
            `dispatchUxfConservativeSend: reservationLedger.commit(${rid}) threw (swallowed): ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`,
          );
        }
      }
    } catch (err) {
      // Loop1-S7 + Loop3-W2 — cancel every reservation id on failure,
      // wrapped per-id so one throw doesn't leak the rest.
      for (const rid of reservationIds) {
        try {
          this.reservationLedger.cancel(rid);
        } catch (cancelErr) {
          logger.warn(
            'Payments',
            `dispatchUxfConservativeSend: reservationLedger.cancel(${rid}) threw (swallowed): ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`,
          );
        }
      }

      // Loop1-S9 + Loop2-W1 — restore non-committed selected sources
      // AND rebuild parsedTokenCache. Same semantics as the instant
      // dispatcher.
      const restoredCoinIds = new Set<string>();
      for (const tokId of dispatcherSelectedTokenIds) {
        if (committedOnChainTokenIds.has(tokId)) continue;
        const tok = this.tokens.get(tokId);
        if (tok !== undefined && tok.status === 'transferring') {
          tok.status = 'confirmed';
          tok.updatedAt = Date.now();
          this.tokens.set(tokId, tok);
          restoredCoinIds.add(tok.coinId);
          if (tok.sdkData) {
            try {
              const parsed = JSON.parse(tok.sdkData);
              const sdkToken = await SdkToken.fromJSON(parsed);
              const amount = this.extractCoinAmountForCache(sdkToken, tok.coinId);
              if (amount > 0n) {
                this.parsedTokenCache.set(tok.id, { token: tok, sdkToken, amount });
              }
            } catch {
              // Parse failure — skip cache rebuild.
            }
          }
        }
      }
      try {
        await this.save();
      } catch {
        // Non-fatal — in-memory state still reflects restoration.
      }
      // Loop2-W2 + Loop3-W1 — notify every coinId the send touched
      // (primary + every additional-asset coin), not just the ones
      // whose tokens we actually restored. Wrapped per coin.
      restoredCoinIds.add(request.coinId);
      for (const asset of originalRequest.additionalAssets ?? []) {
        if (asset.kind === 'coin') {
          restoredCoinIds.add(asset.coinId);
        }
      }
      for (const cid of restoredCoinIds) {
        try {
          this.spendQueue.notifyChange(cid);
        } catch (notifyErr) {
          logger.warn(
            'Payments',
            `dispatchUxfConservativeSend: spendQueue.notifyChange(${cid}) threw (swallowed): ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
          );
        }
      }

      // Item #14 Phase 1 — emit `transfer:double-spend-detected` when
      // the classified-submit helper raised
      // `STATE_ALREADY_SPENT_BY_OTHER`. The diagnostic payload
      // (`tokenId`, `sourceStateHash`, `ourIntendedRecipient`) was
      // stashed via `cause` at the throw site so operators / UIs can
      // route this case differently from `transfer:orphan-spending-detected`
      // (crash-window orphan vs. on-chain double-spend loss).
      this.emitDoubleSpendDetectedIfApplicable(err);

      throw err;
    }

    // #143 UXF + #149 multi-coin — record one SENT history entry per coin
    // shipped in the bundle (primary + each additionalAssets coin). The
    // helper pivots result.tokenTransfers by source coinId and emits an
    // entry per coin; each emission is wrapped in its own try/catch so a
    // history I/O hiccup never flips a successful send into a thrown error.
    await this.recordUxfBundleSentHistory({
      originalRequest,
      request,
      result,
      peerInfo,
      recipientPubkey,
      recipientAddress,
      diagLabel: 'dispatchUxfConservativeSend',
    });

    return result;
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trustBase = (this.deps!.oracle as any).getTrustBase?.();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const devMode = (this.deps!.oracle as any).isDevMode?.() ?? false;

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

    // #142 — closure-captured queue of fire-and-forget post-transport
    // tasks. Currently only used by the split path to invoke
    // `awaitChangeTokenWithProofs()` after the bundle has shipped
    // (mirrors the legacy V6 path's `startBackground()` call at
    // PaymentsModule.ts:3772-3775). Failure inside any callback is
    // logged but never propagated — the publish has already succeeded.
    const postTransportBackgroundTasks: Array<() => Promise<void>> = [];

    // Loop1-S9 — every token selectSources marked `transferring` is
    // pushed here so the outer catch can restore non-committed
    // sources back to `confirmed` on failure. Without this, a
    // multi-source send that throws mid-commitSources leaves
    // already-marked-but-not-yet-committed tokens stuck `transferring`
    // forever (the spend planner skips them).
    const dispatcherSelectedTokenIds: string[] = [];

    // Loop1-S4 — tracks tokens whose ON-CHAIN commitment has been
    // submitted (split: burn proof landed; direct: transfer commit
    // accepted). The outer catch MUST NOT restore these to `confirmed`
    // — they're irrecoverable on-chain. Mirrors the legacy `send()`
    // arm's `committedOnChainTokenIds` (PaymentsModule.ts:3886).
    const dispatcherCommittedOnChainTokenIds = new Set<string>();

    // #149 — per-coin reservation ids. Mirrors the conservative
    // dispatcher's `reservationIds` array pattern (line ~8400). With
    // multi-asset planSend calls in `selectSources` below, each coin
    // gets its own `${transferId}:${coinId}[:${i}]` queue id so
    // promise-map collisions can't happen.
    const reservationIds: string[] = [];

    const deps: InstantSenderDeps = {
      aggregator: this.deps!.oracle,
      transport: this.deps!.transport,
      tokenStorage: null,
      identity: this.deps!.identity,
      addressId,
      senderTransportPubkey: this.deps!.identity.chainPubkey,
      emit: (type, data) => this.deps!.emitEvent(type, data),
      // Issue #200 Phase 1 wiring: when the host injected a
      // `publishToIpfs` callback into `PaymentsModuleDependencies`,
      // pass it through to the instant sender so CID-bound delivery
      // branches actually pin. Absent → inline fallback (under cap) or
      // `IPFS_PUBLISHER_REQUIRED` throw (force-cid / over-cap auto).
      // MUST come from `createUxfCarPublisher` (see
      // `./transfer/ipfs-publisher.ts`).
      publishToIpfs: this.deps!.publishToIpfs,
      availableSources: () => Array.from(this.tokens.values()),
      transferId,
      selectSources: async ({ request: req }) => {
        // #142/#149 — return the STRUCTURED selection shape with
        // `splitSources` (array). One entry per coin that needs
        // splitting (primary + each additional-asset coin). Direct
        // (whole-token) sources go into directSources.
        const directSources: Token[] = [];
        const splitSources: Array<NonNullable<InstantSourceSelection['splitSources']>[number]> = [];

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
        // Per-coin reservation id (mirrors conservative dispatcher).
        const primaryQueueId = `${transferId}:${request.coinId}`;
        reservationIds.push(primaryQueueId);
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

        directSources.push(...splitPlan.tokensToTransferDirectly.map((t) => t.uiToken));

        if (splitPlan.tokenToSplit) {
          // Loop1-S2 — defensive guard. If the planner emits
          // `tokenToSplit` but `splitAmount` / `remainderAmount` is
          // null/zero, the previous code silently called BigInt(0) and
          // buildSplitBundle would burn the source for nothing
          // (zero-coin recipient, irrecoverable). Surface as an
          // INVALID_CONFIG throw — this is a planner bug, not user
          // input. Source stays `transferring`; outer catch restores
          // it via Loop1-S9 wiring (below in dispatcher).
          if (
            splitPlan.splitAmount === null ||
            splitPlan.remainderAmount === null ||
            splitPlan.splitAmount <= 0n
          ) {
            throw new SphereError(
              `dispatchUxfInstantSend: planner returned tokenToSplit with null/zero splitAmount=${String(splitPlan.splitAmount)} / remainderAmount=${String(splitPlan.remainderAmount)} for primary coinId=${request.coinId.slice(0, 16)}; refusing to burn source for zero-coin recipient`,
              'INVALID_CONFIG',
            );
          }
          splitSources.push({
            token: splitPlan.tokenToSplit.uiToken,
            splitAmount: splitPlan.splitAmount,
            remainderAmount: splitPlan.remainderAmount,
            coinIdHex: request.coinId,
          });
        }

        // ── Additional assets (coin entries only) ─────────────────────────────
        // #149 — mirror conservative dispatcher; loop additionalAssets
        // and plan each independently. NFT entries are whole-token
        // (handled by commitSources, no plan needed).
        const additional = req.additionalAssets ?? [];
        for (let i = 0; i < additional.length; i++) {
          const asset = additional[i];
          if (asset.kind !== 'coin') continue;
          const addCoinId = asset.coinId;
          if (addCoinId === request.coinId) {
            throw new SphereError(
              `dispatchUxfInstantSend: additionalAssets[${i}].coinId duplicates primary coinId=${addCoinId.slice(0, 16)}; ` +
                'combine the amounts into the primary slot instead',
              'INVALID_CONFIG',
            );
          }
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
          reservationIds.push(addQueueId);
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
          directSources.push(...addSplitPlan.tokensToTransferDirectly.map((t) => t.uiToken));
          if (addSplitPlan.tokenToSplit) {
            if (
              addSplitPlan.splitAmount === null ||
              addSplitPlan.remainderAmount === null ||
              addSplitPlan.splitAmount <= 0n
            ) {
              throw new SphereError(
                `dispatchUxfInstantSend: planner returned tokenToSplit with null/zero splitAmount=${String(addSplitPlan.splitAmount)} / remainderAmount=${String(addSplitPlan.remainderAmount)} for additional coinId=${addCoinId.slice(0, 16)}; refusing to burn source for zero-coin recipient`,
                'INVALID_CONFIG',
              );
            }
            splitSources.push({
              token: addSplitPlan.tokenToSplit.uiToken,
              splitAmount: addSplitPlan.splitAmount,
              remainderAmount: addSplitPlan.remainderAmount,
              coinIdHex: addCoinId,
            });
          }
        }

        // Issue #166 P2 #2 — duplicate-bundle guard. Same contract as
        // the conservative dispatcher above; see that site for the
        // rationale + best-effort semantics.
        await this.assertNoDuplicateBundleMembership(
          [
            ...directSources.map((t) => t.id),
            ...splitSources.map((e) => e.token.id),
          ],
          {
            opLabel: 'dispatchUxfInstantSend',
            allowOverride: req.allowDuplicateBundleMembership === true,
          },
        );

        // Mark every selected source `transferring` + persist.
        for (const tok of directSources) {
          tok.status = 'transferring';
          this.tokens.set(tok.id, tok);
          this.parsedTokenCache.delete(tok.id);
          dispatcherSelectedTokenIds.push(tok.id);
        }
        for (const entry of splitSources) {
          entry.token.status = 'transferring';
          this.tokens.set(entry.token.id, entry.token);
          this.parsedTokenCache.delete(entry.token.id);
          dispatcherSelectedTokenIds.push(entry.token.id);
        }
        await this.save();
        return { directSources, splitSources };
      },
      commitSources: async ({ sources, splitSources }) => {
        const out: InstantCommitResult[] = [];
        // #149 — tokenId → splitEntry lookup for O(1) routing.
        // Orchestrator already validated tokenId uniqueness.
        const splitEntryByTokenId = new Map<
          string,
          NonNullable<InstantSourceSelection['splitSources']>[number]
        >();
        for (const entry of splitSources ?? []) {
          splitEntryByTokenId.set(entry.token.id, entry);
        }
        for (const token of sources) {
          // #142/#149 — split path. The legacy implementation discarded
          // the split intent and whole-token-transferred the source.
          // The fix routes each split source through InstantSplitExecutor
          // which burns the source and mints two new tokens: a
          // `splitAmount` slice for the recipient (transferred to
          // recipientAddress) and a `remainderAmount` change token
          // (kept by the sender). Coin sources are split via mint —
          // recipient and change get fresh tokenIds. Multiple split
          // entries (one per coin) run independent buildSplitBundle
          // invocations.
          const splitEntry = splitEntryByTokenId.get(token.id);
          if (splitEntry !== undefined) {
            if (trustBase === undefined) {
              throw new SphereError(
                'Trust base not available. Oracle provider must implement getTrustBase() for partial-amount sends.',
                'AGGREGATOR_ERROR',
              );
            }
            if (!token.sdkData || typeof token.sdkData !== 'string') {
              throw new SphereError(
                `Split source token ${token.id} missing sdkData`,
                'TRANSFER_FAILED',
              );
            }
            const sdkSourceToken = await SdkToken.fromJSON(JSON.parse(token.sdkData));
            const executor = new InstantSplitExecutor({
              stateTransitionClient: stClient,
              trustBase,
              signingService,
              devMode,
            });

            // Loop1-S4 + Loop2-C2 — burn-then-removeToken via
            // try/finally with `onBurnSubmitted` callback. The
            // executor invokes `onBurnSubmitted` AFTER its step-1
            // burn submit response is SUCCESS (durable on-chain) and
            // BEFORE the step-2 proof wait. From that moment on, any
            // throw — proof wait timeout, mint submit failure,
            // anything — leaves the source on-chain spent, so the
            // local source MUST be tombstoned. Pre-Loop2-C2 only
            // tracked `burnDone=true` AFTER buildSplitBundle returned
            // (= proof received) — proof-wait throws left the source
            // on-chain spent but not tombstoned.
            let burnDone = false;
            try {
              // #149 — capture coinId in a local for the change-token
              // callback closure. Using `splitEntry.coinIdHex` directly
              // works (the entry is loop-scoped), but a named local is
              // clearer and matches the conservative dispatcher's
              // pattern.
              const changeCoinId = splitEntry.coinIdHex;
              const splitResult = await executor.buildSplitBundle(
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                sdkSourceToken as any,
                splitEntry.splitAmount,
                splitEntry.remainderAmount,
                splitEntry.coinIdHex,
                recipientAddress,
                {
                  message: onChainMessage,
                  // UXF dispatcher drives commitment submission via
                  // submitCommitmentsImmediate; suppress the legacy
                  // background path so commitments aren't double-submitted.
                  skipBackground: true,
                  // CONTRACT (Loop3-W3): this callback MUST NOT
                  // THROW. The executor catches and swallows any
                  // throw, but a throw here would leave `burnDone`
                  // false while the burn IS on-chain spent —
                  // recreating the phantom-token regression
                  // Loop2-C2 was designed to close. Keep this
                  // callback simple: `Set.add` + primitive
                  // assignment ONLY. Do NOT add any async / I/O /
                  // throwing operation here.
                  onBurnSubmitted: () => {
                    burnDone = true;
                    dispatcherCommittedOnChainTokenIds.add(token.id);
                  },
                  onChangeTokenCreated: async (changeToken) => {
                    // Persist the change token via the standard addToken
                    // pipeline. Fires after awaitChangeTokenWithProofs
                    // gets the sender's mint proof (~2s post-transport).
                    // #149 — use splitEntry.coinIdHex (NOT request.coinId)
                    // because additional-asset splits change-mint into
                    // their own coin class.
                    const changeTokenData = changeToken.toJSON();
                    const changeUiToken: Token = {
                      id: crypto.randomUUID(),
                      coinId: changeCoinId,
                      symbol: this.getCoinSymbol(changeCoinId),
                      name: this.getCoinName(changeCoinId),
                      decimals: this.getCoinDecimals(changeCoinId),
                      iconUrl: this.getCoinIconUrl(changeCoinId),
                      amount: splitEntry.remainderAmount.toString(),
                      status: 'confirmed',
                      createdAt: Date.now(),
                      updatedAt: Date.now(),
                      sdkData: JSON.stringify(changeTokenData),
                    };
                    await this.addToken(changeUiToken);
                    logger.debug(
                      'Payments',
                      `dispatchUxfInstantSend: change token persisted (coin=${changeCoinId.slice(0, 16)} amount=${changeUiToken.amount})`,
                    );
                  },
                  onStorageSync: async () => {
                    await this.save();
                    return true;
                  },
                },
              );
              // Loop2-C2 — `burnDone` is set by the onBurnSubmitted
              // callback inside buildSplitBundle, which fires AFTER the
              // burn submit response is SUCCESS and BEFORE the proof
              // wait. The callback already added `token.id` to
              // `dispatcherCommittedOnChainTokenIds`; nothing more to
              // do here. The contract is single-path:
              //
              //   callback fires ⇔ burn is on-chain ⇔ source tombstoned
              //
              // If buildSplitBundle returns without invoking the
              // callback (which would require an executor regression),
              // burnDone stays false and the source is restored by the
              // outer catch.

              // Loop1-S4 — queue awaitChangeTokenWithProofs BEFORE
              // submitCommitmentsImmediate so a partial-failure path
              // (sender mint succeeds, recipient mint or transfer
              // fails) still runs the change-token recovery. The bg
              // task is fired in BOTH success and failure paths of
              // the outer dispatcher catch.
              if (splitResult.awaitChangeTokenWithProofs !== undefined) {
                const bgTask = splitResult.awaitChangeTokenWithProofs;
                postTransportBackgroundTasks.push(async () => {
                  await bgTask();
                });
              }

              // Submit the three commitments (sender mint → recipient
              // mint → transfer; serial per Loop1-S3) to the aggregator
              // AND wait for the recipient mint inclusion proof (Loop4
              // e2e fix — UXF format requires genesis.inclusionProof
              // to be non-null). Fails on any non-SUCCESS — but the
              // burn is already anchored, so the source is gone
              // regardless.
              if (splitResult.submitCommitmentsImmediate === undefined) {
                throw new SphereError(
                  'InstantSplitExecutor.buildSplitBundle did not expose submitCommitmentsImmediate ' +
                    '— UXF dispatcher requires the #142 wiring',
                  'INVALID_CONFIG',
                );
              }
              const {
                recipientMintProvenGenesisJson,
                transferTransactionHashHex,
                transferAuthenticatorJsonStr,
              } = await splitResult.submitCommitmentsImmediate();

              // Loop4-S2 — populate per-requestId context for the
              // sender-side §6.1 finalization worker. Mirrors the
              // direct-path block at line ~9435 (Task #152 wiring).
              // Without this, the worker's resolver returns null on
              // the split-path requestId, hard-fails 'structural',
              // and `transfer:confirmed` never fires — the outbox
              // entry stays stuck at `delivered-instant` forever.
              if (
                this.finalizationWorkerSender !== null &&
                splitResult.transferRequestIdHex !== undefined &&
                splitResult.transferRequestIdHex.length > 0
              ) {
                this._senderRequestContextMap.set(splitResult.transferRequestIdHex, {
                  transactionHash: transferTransactionHashHex,
                  authenticator: transferAuthenticatorJsonStr,
                  nextEntryRest: { status: 'valid' as const },
                });
              }

              // Assemble recipient SDK Token JSON. The genesis is the
              // proven recipient mint transaction (with inclusionProof)
              // — required by the UXF format. The transfer transaction
              // ships with `inclusionProof: null`; the recipient's
              // chain-walker resolves it against the aggregator after
              // the transfer commit's proof lands.
              //
              // `recipientMintProvenGenesisJson` is already the
              // `{data, inclusionProof}` shape from
              // `TransferTransaction.toJSON()` — splatted directly into
              // the genesis slot.
              const recipientTokenJson = {
                version: '2.0',
                genesis: recipientMintProvenGenesisJson,
                state: splitResult.recipientMintedStateJson,
                transactions: [
                  {
                    data: splitResult.transferTxDataJson,
                    inclusionProof: null,
                  },
                ],
                nametags: [] as ReadonlyArray<unknown>,
              };

              out.push({
                sourceTokenId: token.id,
                method: 'split',
                requestIdHex: splitResult.transferRequestIdHex ?? '',
                recipientTokenJson,
                tokenClass: 'coin',
                splitParentTokenId: token.id,
                splitGroupId: splitResult.splitGroupId,
              });
            } finally {
              if (burnDone) {
                try {
                  // #143 UXF — source token is spent on-chain (burn
                  // submitted by buildSplitBundle step 1). Tombstone
                  // here in finally so even if submitCommitments or
                  // any later step threw, the source is removed and
                  // does not return as `confirmed` on the next load.
                  await this.removeToken(token.id, transferId);
                } catch (rmErr) {
                  logger.warn(
                    'Payments',
                    `dispatchUxfInstantSend: removeToken(${token.id}) failed after burn — manual cleanup may be needed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
                  );
                }
              }
            }
            continue;
          }

          // Direct (whole-token) path — unchanged from pre-#142
          // behaviour for sources that the spend planner picked WITHOUT
          // a split. Submits the transfer commitment without awaiting
          // the inclusion proof; recipient's chain-walker resolves it
          // when the aggregator returns it.
          const commitment = await this.createSdkCommitment(
            token,
            recipientAddress,
            signingService,
            onChainMessage,
          );
          // Item #14 Phase 1 — route through the classified-submit
          // helper so a "state already spent by another commit"
          // outcome surfaces as `STATE_ALREADY_SPENT_BY_OTHER` (the
          // outer catch emits `transfer:double-spend-detected`)
          // rather than the legacy generic `TRANSFER_FAILED`.
          await this.submitCommitmentClassified(
            stClient,
            this.deps?.oracle,
            commitment,
            {
              tokenId: token.id,
              intendedRecipient: originalRequest.recipient,
            },
          );
          // Loop2-C1 — commit is on-chain from this point. Track AND
          // wrap the entire post-submit block in try/finally so
          // removeToken always fires, even if any of the JSON
          // construction / hash / classification steps throws.
          // Previous Loop1-S4 placement (add outside the try, try only
          // around the out.push) left a wide window where a throw
          // would leave the source committed-but-not-removed → zombie
          // `transferring` row after outer catch skipped restoration.
          let directCommitted = false;
          try {
            directCommitted = true;
            dispatcherCommittedOnChainTokenIds.add(token.id);
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
          //
          // Wave 6 — DO NOT embed `data.authenticator`. The Wave 5 attempt
          // to add `authenticator` under `data` was dead code in production:
          // the bundle is handed to `pkg.ingestAll(...)` which calls
          // `deconstructTransferData` (uxf/deconstruct.ts:486-512). That
          // function only deconstructs the explicit fields {recipient, salt,
          // recipientDataHash, message, nametagRefs} — `authenticator` is
          // silently dropped from the IPLD pool. On the recipient side,
          // `pkg.assemble(tokenId)` calls `assembleTransactionData`
          // (uxf/assemble.ts:361-398) which returns ONLY {sourceState,
          // recipient, salt, recipientDataHash, message, nametags}, so
          // `lastTxJson.data.authenticator` is undefined for EVERY round-
          // tripped bundle.
          //
          // The Wave 5 byte-pattern + synthetic test passed because it
          // never round-tripped through `pkg.ingestAll → pkg.toCar →
          // UxfPackage.fromCar → pkg.assemble`. We degrade gracefully
          // instead of extending the IPLD wire format: §6.1 race-lost
          // only depends on `transactionHash` (load-bearing), and §6.3
          // most-recent-proof compare uses the AGGREGATOR-returned
          // authenticator on both sides — the queue entry's authenticator
          // is metadata only. The recipient sets `authenticator = null`
          // and `canonicalAuthenticatorEquals` degrades to
          // transactionHash-only binding (the load-bearing check).
          const commitmentJson = commitment.toJSON();
          const transferTxJson = {
            data: commitmentJson.transactionData,
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
          // Loop2-C3 — tighten requestIdHex extraction. RequestId
          // extends DataHash whose toJSON() returns a hex imprint.
          // The previous fallback `String(requestIdBytes)` would ship
          // `"[object Object]"` if the SDK shape ever changed. Validate
          // explicitly and throw on SDK shape regression.
          const requestIdHexRawDirect = (commitment.requestId as { toJSON?: () => string })?.toJSON?.();
          if (typeof requestIdHexRawDirect !== 'string' || !/^[0-9a-f]+$/i.test(requestIdHexRawDirect)) {
            throw new SphereError(
              `dispatchUxfInstantSend: commitment.requestId.toJSON() returned non-hex (${typeof requestIdHexRawDirect}); SDK shape regression?`,
              'TRANSFER_FAILED',
            );
          }
          const requestIdHex = requestIdHexRawDirect;

          // Task #152 — store per-requestId context for the finalization
          // worker resolver. The §6.1 race-lost detection compares the LOCAL
          // `transactionHash` against the proof's `transactionHash` byte-for-
          // byte; both sides MUST be the actual SDK-encoded DataHash imprint
          // hex of the transaction-data hash (NOT the requestId).
          //
          //   - `transactionHash`: derived from `commitment.transactionData
          //     .calculateHash()` — same value the aggregator returns in
          //     `proof.transactionHash` once the commitment lands on chain.
          //   - `authenticator`: the canonical JSON serialization of the
          //     commitment's authenticator (publicKey + algorithm + signature
          //     + stateHash). Stored as a stable string so §6.3 byte-equality
          //     compares against the aggregator-returned authenticator JSON.
          //
          // Race-lost detection (finalization-worker-base.ts §6.1) compares
          // `pollOutcome.proof.transactionHash !== ctxResolved.transactionHash`.
          // Before this fix both sides used the requestId, making the compare
          // trivially equal and the detector silently dead in production.
          if (this.finalizationWorkerSender !== null) {
            // Compute the actual transactionHash imprint hex. `calculateHash`
            // returns a DataHash; `.toJSON()` returns the imprint hex.
            let txHashImprintHex: string;
            try {
              const txDataHash = await commitment.transactionData.calculateHash();
              txHashImprintHex = txDataHash.toJSON();
            } catch (err) {
              // Hard failure here would mean we cannot detect race-lost for
              // this commitment. Surface a clear runtime warning rather than
              // silently fall back to the requestId (which would re-introduce
              // the bug). Use the requestId hex as a non-fatal degraded value
              // and log so operators see the diagnostic.
              logger.warn(
                'Payments',
                `Task #152: failed to derive transactionHash for requestId ${requestIdHex.slice(0, 16)} — race-lost detection degraded (falling back to requestId). err=${err instanceof Error ? err.message : String(err)}`,
              );
              txHashImprintHex = requestIdHex;
            }
            // Stable canonical JSON of the authenticator. The aggregator-
            // returned proof carries the same shape (IAuthenticatorJson) in
            // `proof.proof.authenticator`; the adapter at line ~9026 strings
            // its copy with the same JSON.stringify() so byte-equality holds
            // for §6.3 same-value vs different-value resolution.
            const commitJson = (commitment as { toJSON?: () => { authenticator?: unknown } }).toJSON?.();
            const authenticatorJsonStr =
              commitJson?.authenticator !== undefined && commitJson.authenticator !== null
                ? JSON.stringify(commitJson.authenticator)
                : '';
            this._senderRequestContextMap.set(requestIdHex, {
              transactionHash: txHashImprintHex,
              authenticator: authenticatorJsonStr,
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
          } finally {
            // Loop2-C1 — removeToken always fires when the on-chain
            // commit is durable, regardless of any throw in the
            // post-submit JSON construction or classification path.
            // The try block starts immediately after submit-success
            // so this finally catches the widest possible window.
            if (directCommitted) {
              try {
                await this.removeToken(token.id, transferId);
              } catch (rmErr) {
                logger.warn(
                  'Payments',
                  `dispatchUxfInstantSend: removeToken(${token.id}) failed after on-chain commit — manual cleanup may be needed: ${rmErr instanceof Error ? rmErr.message : String(rmErr)}`,
                );
              }
            }
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
      // Phase 9.6.D + Issue #97 — wire the outbox-write hook so the
      // instant-sender persists every `packaging`/`pinned`/`sending`/
      // `delivered-instant` entry. The hook fires whenever EITHER:
      //  - a profile-resident OutboxWriter is installed (#97 crash
      //    safety — survives total local profile loss), OR
      //  - a finalization worker is installed (Phase 9.6.D — worker
      //    reads the in-memory map via FinalizationOutboxWriter).
      // When neither is wired, the hook is undefined (original T.5.A
      // behaviour — bare orchestrator path used by some unit tests).
      outbox: (this._outboxWriter !== null || this.finalizationWorkerSender !== null)
        ? {
            write: async (entry) => {
              const writer = this._outboxWriter;
              if (writer !== null) {
                // Durable profile write first — _senderOutboxMap is
                // mirrored from the returned stamped value so the
                // Lamport matches the writer's CRDT bump rule (§7.1).
                const written = await writer.write(entry);
                this._senderOutboxMap.set(entry.id, written);
              } else {
                // Legacy in-memory path — finalization worker only.
                const existing = this._senderOutboxMap.get(entry.id);
                this._senderOutboxMap.set(entry.id, {
                  ...entry,
                  _schemaVersion: 'uxf-1' as const,
                  lamport: (existing?.lamport ?? 0) + 1,
                });
              }

              // Issue #97 — write the SENT ledger entry on first
              // entry into the terminal-success status. In instant
              // mode the outbox entry stays live (the finalization
              // worker continues writing through it), so SENT and
              // OUTBOX coexist until the worker reaches `'finalized'`.
              // The `_schemaVersion: 'uxf-1'` discriminator on SENT
              // entries keeps them disjoint from the outbox keyspace.
              //
              // Idempotency: SentLedgerWriter.write is second-write-
              // wins. Repeated transitions into `delivered-instant`
              // (e.g. the recovery worker re-entering the same status
              // after a republish) re-stamp the SENT entry with a
              // fresh lamport but produce no duplicate record.
              //
              // SENT-write failure: error is logged at ERROR; the
              // bundle is already on the wire. No automatic recovery
              // — operator triage required (the sweeper cannot help
              // here because the source token is already cleared).
              if (entry.status === 'delivered-instant') {
                // OUTBOX-SEND-FOLLOWUPS item #7 — the helper's
                // parameter type is `OutboxCreateInput`, exactly the
                // shape the orchestrator passes here. No synthetic
                // `_schemaVersion`/`lamport: 0` placeholder needed:
                // neither field is read by the SENT-write path.
                await this.writeSentEntryFromOutbox(
                  entry,
                  'dispatchUxfInstantSend',
                );
              }
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

    // Loop1-S4/S7/S9 — wrap sendInstantUxf with reservation lifecycle
    // + source restoration + background-task firing in BOTH success
    // and failure paths. The orchestrator does not roll back source
    // state on failure; the dispatcher owns the cleanup.
    let result: TransferResult;
    try {
      result = await sendInstantUxf(originalRequest, recipient, deps);
      // Loop1-S7 + Loop3-W2 + #149 — commit every reservation id on
      // success (primary + per-additional-asset queue ids). Wrap each
      // in try/catch: ReservationLedger.commit is currently non-
      // throwing, but a future invariant assert shouldn't leak the
      // remaining commits. Mirrors the conservative dispatcher's
      // pattern (line ~8815).
      for (const rid of reservationIds) {
        try {
          this.reservationLedger.commit(rid);
        } catch (commitErr) {
          logger.warn(
            'Payments',
            `dispatchUxfInstantSend: reservationLedger.commit(${rid}) threw (swallowed): ${commitErr instanceof Error ? commitErr.message : String(commitErr)}`,
          );
        }
      }
    } catch (err) {
      // Loop1-S7 + Loop3-W2 + #149 — cancel every reservation id on
      // failure, wrapped per-id so one throw doesn't leak the rest.
      for (const rid of reservationIds) {
        try {
          this.reservationLedger.cancel(rid);
        } catch (cancelErr) {
          logger.warn(
            'Payments',
            `dispatchUxfInstantSend: reservationLedger.cancel(${rid}) threw (swallowed): ${cancelErr instanceof Error ? cancelErr.message : String(cancelErr)}`,
          );
        }
      }

      // Loop1-S9 + Loop2-W1 — restore any selected source NOT yet
      // on-chain committed. Without this, a multi-source send that
      // throws mid-commitSources (e.g. source-2's submit fails after
      // source-1 succeeded) leaves the still-`transferring` sources
      // stuck forever — the spend planner ignores them.
      //
      // Loop2-W1 — rebuild parsedTokenCache for the restored token so
      // the spend planner sees it again. Mirrors the legacy send()
      // catch path (PaymentsModule.ts:3900-3908). Without this, the
      // restored token is in `this.tokens` as `confirmed` but
      // invisible to spend planning until the next save/sync
      // rebuilds the cache.
      const restoredCoinIds = new Set<string>();
      for (const tokId of dispatcherSelectedTokenIds) {
        if (dispatcherCommittedOnChainTokenIds.has(tokId)) continue;
        const tok = this.tokens.get(tokId);
        if (tok !== undefined && tok.status === 'transferring') {
          tok.status = 'confirmed';
          tok.updatedAt = Date.now();
          this.tokens.set(tokId, tok);
          restoredCoinIds.add(tok.coinId);
          if (tok.sdkData) {
            try {
              const parsed = JSON.parse(tok.sdkData);
              const sdkToken = await SdkToken.fromJSON(parsed);
              const amount = this.extractCoinAmountForCache(sdkToken, tok.coinId);
              if (amount > 0n) {
                this.parsedTokenCache.set(tok.id, { token: tok, sdkToken, amount });
              }
            } catch {
              // Parse failure — skip cache rebuild. Token still
              // marked confirmed; planner will re-parse on next
              // buildParsedPool.
            }
          }
        }
      }
      try {
        await this.save();
      } catch {
        // save() failure here is non-fatal; the in-memory restoration
        // applies for the rest of this session and the next load will
        // see the persistent state.
      }
      // Loop2-W2 + Loop3-W1 — notify the spend queue for EVERY
      // coinId the send touched, not just the ones whose tokens we
      // actually restored. A planSend failure on coin USDU before
      // ANY USDU token got marked `transferring` would otherwise
      // leave USDU's queue waiters parked indefinitely. Wrap each
      // notify in try/catch so a listener error doesn't mask the
      // original throw.
      restoredCoinIds.add(request.coinId);
      for (const asset of originalRequest.additionalAssets ?? []) {
        if (asset.kind === 'coin') {
          restoredCoinIds.add(asset.coinId);
        }
      }
      for (const cid of restoredCoinIds) {
        try {
          this.spendQueue.notifyChange(cid);
        } catch (notifyErr) {
          logger.warn(
            'Payments',
            `dispatchUxfInstantSend: spendQueue.notifyChange(${cid}) threw (swallowed): ${notifyErr instanceof Error ? notifyErr.message : String(notifyErr)}`,
          );
        }
      }

      // Loop1-S4 — fire post-transport bg tasks on failure too. The
      // change-token recovery task (awaitChangeTokenWithProofs) is
      // queued BEFORE submitCommitmentsImmediate in the split branch
      // (see Loop1-S4 in commitSources). If submit threw, the sender
      // mint may STILL have anchored (it's the first submission), in
      // which case the change-token recovery is needed even though
      // the dispatch failed.
      for (const task of postTransportBackgroundTasks) {
        const tracked: Promise<void> = task().catch((bgErr) => {
          logger.debug(
            'Payments',
            `dispatchUxfInstantSend: background task threw (post-failure): ${bgErr instanceof Error ? bgErr.message : String(bgErr)}`,
          );
        });
        // Push to module-level pending list so waitForPendingOperations()
        // drains them and tests can `await sphere.waitForPendingOperations()`.
        this.pendingBackgroundTasks.push(tracked);
      }

      // Item #14 Phase 1 — emit `transfer:double-spend-detected` if
      // the classified-submit helper raised
      // `STATE_ALREADY_SPENT_BY_OTHER`. Mirrors the conservative
      // dispatcher's emit; see that catch for the rationale.
      this.emitDoubleSpendDetectedIfApplicable(err);

      throw err;
    }

    // SUCCESS PATH: fire post-transport bg tasks.
    // #142 — each task is `awaitChangeTokenWithProofs()` for a split
    // source; it waits for the sender's mint proof (~2s) and persists
    // the change token via the closure-captured `onChangeTokenCreated`
    // callback. Failure is logged inside `awaitChangeTokenWithProofs`
    // (never re-thrown), so a `.catch` here is defense-in-depth only.
    for (const task of postTransportBackgroundTasks) {
      const tracked: Promise<void> = task().catch((err) => {
        logger.debug(
          'Payments',
          `dispatchUxfInstantSend: background task threw (post-transport): ${err instanceof Error ? err.message : String(err)}`,
        );
      });
      // Loop1-S8 — track at module level so waitForPendingOperations()
      // can drain them.
      this.pendingBackgroundTasks.push(tracked);
    }

    // #143 UXF + #149 multi-coin — record one SENT history entry per coin
    // shipped in the bundle (primary + each additionalAssets coin). The
    // helper pivots result.tokenTransfers by source coinId and emits an
    // entry per coin; each emission is wrapped in its own try/catch so a
    // history I/O hiccup never flips a successful send into a thrown error.
    await this.recordUxfBundleSentHistory({
      originalRequest,
      request,
      result,
      peerInfo,
      recipientPubkey,
      recipientAddress,
      diagLabel: 'dispatchUxfInstantSend',
    });

    return result;
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
        // Issue #166 P2 #2 — duplicate-bundle guard for the legacy TXF
        // path. Same contract as the UXF dispatchers above; guard
        // throws BEFORE the mark loop so source statuses are
        // preserved on rejection.
        await this.assertNoDuplicateBundleMembership(
          out.map((t) => t.id),
          {
            opLabel: 'dispatchUxfTxfLegacySend',
            allowOverride: req.allowDuplicateBundleMembership === true,
          },
        );
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
  /**
   * Pre-validate that the wallet's signing key owns every source token planned
   * for spending. Each source token's current-state predicate is reconstructed
   * via `PredicateEngineService.createPredicate(...)` and checked with
   * `predicate.isOwner(signingService.publicKey)`. Throws
   * `OWNERSHIP_VERIFICATION_FAILED` immediately on any mismatch.
   *
   * Why this exists. Both the conservative and the instant (V6) send paths
   * submit transfer commitments to the aggregator's
   * `submitTransferCommitment(...)`, which itself runs an identical predicate-
   * ownership check (state-transition-sdk
   * `StateTransitionClient.submitTransferCommitment` line ~41). In conservative
   * mode the throw is awaited and propagated, the outer catch restores the
   * source tokens, no value is lost. In instant mode, however, the bundle is
   * shipped to the recipient FIRST, and the per-direct-token submissions run
   * fire-and-forget on a background task (see line ~1444 — the
   * "Background commitment submit failed" log). When the background submit
   * fails:
   *
   *  1. The Nostr bundle has already been delivered, so the recipient has
   *     seen the tokens.
   *  2. The on-chain commitment never landed, so the recipient cannot
   *     finalize.
   *  3. If a split was part of the same bundle, the burn of the split
   *     source has ALREADY happened (`buildSplitBundle` submits the burn
   *     synchronously); the change token mint is also in-flight in the
   *     background queue.
   *  4. The sender's send() returns `status: 'completed'` (because the
   *     foreground transport completed), but the source tokens that were
   *     intended to be spent end up in a damaged state — the failed direct
   *     transfer can't be retried (the bundle already shipped), and the
   *     burned split source has lost its change to the in-flight queue.
   *
   * The repro is the pay-invoice test for the manual-test session: Bob holds
   * 1000 UCT + 10 UCT (the 10 UCT was received from Alice via the same instant
   * path with the same predicate-state staleness symptom), tries to pay an
   * 11-UCT invoice; the split picks the 1000-UCT token as the splittable, the
   * 10-UCT token as the direct. The direct commitment's predicate check
   * against Bob's signing key fails because the 10-UCT token's local
   * current-state predicate is still set to the PRE-transfer state (Alice's
   * predicate) rather than the POST-transfer state (Bob's predicate).
   *
   * The deeper fix — make the receive flow always finalize the state to the
   * post-transfer predicate before persisting — is out of scope here.
   * Pre-validation converts the silent damage into a loud fail-fast: the
   * outer send() catch block (line ~1520) cancels the reservation and
   * restores the source tokens to `confirmed`. No on-chain work has happened
   * yet because we check BEFORE the split-bundle build and BEFORE the direct
   * commitments are submitted.
   *
   * @throws {SphereError} `OWNERSHIP_VERIFICATION_FAILED` — at least one
   *         source token's current-state predicate does not match the
   *         wallet's signing key.
   */
  private async validateSourceOwnership(
    sourceTokens: ReadonlyArray<{ uiToken: Token; sdkToken: SdkToken<any> } | Token>,
    signingService: SigningService,
  ): Promise<void> {
    const publicKey = signingService.publicKey;
    for (const entry of sourceTokens) {
      // Accept both UI Token (with sdkData) and TokenWithAmount-shaped objects
      // {uiToken, sdkToken}. The latter is what splitPlan.tokensToTransferDirectly
      // already has parsed; the former is the splitPlan.tokenToSplit.uiToken
      // before we parse it.
      let sdkToken: SdkToken<any> | null = null;
      let uiTokenId: string;
      if ('sdkToken' in entry) {
        sdkToken = entry.sdkToken;
        uiTokenId = entry.uiToken.id;
      } else {
        const sdkData = entry.sdkData;
        uiTokenId = entry.id;
        if (!sdkData) continue; // not an on-chain spendable token — skip
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          sdkToken = await SdkToken.fromJSON(JSON.parse(sdkData) as any) as SdkToken<any>;
        } catch {
          // Unparseable sdkData — let downstream code handle (will throw on
          // commitment construction). Don't fail the pre-check here.
          continue;
        }
      }
      // Defensive: if any of the SDK shape is missing (e.g. mocked-out test
      // doubles), skip — we cannot validate without a real predicate, and
      // letting downstream code run is the existing behaviour for these
      // cases. Production tokens always carry a real predicate.
      if (!sdkToken || !sdkToken.state || !sdkToken.state.predicate) continue;
      let predicate;
      try {
        predicate = await PredicateEngineService.createPredicate(sdkToken.state.predicate);
      } catch {
        // Predicate engine couldn't materialise the predicate — same logic
        // as above; let downstream handle it rather than fail-closing here
        // on a shape we can't reason about.
        continue;
      }
      let owned: boolean;
      try {
        owned = await predicate.isOwner(publicKey);
      } catch {
        // isOwner threw — defer to downstream. We only fail-fast on the
        // EXPLICIT non-ownership case where every SDK call succeeded.
        continue;
      }
      if (!owned) {
        throw new SphereError(
          `Cannot spend token ${uiTokenId.slice(0, 16)}: source state predicate does not match wallet's signing key. ` +
            `The token may be in a stale post-receive state — try sync + receive --finalize, or re-import.`,
          'OWNERSHIP_VERIFICATION_FAILED',
        );
      }
    }
  }

  /**
   * OUTBOX-SEND-FOLLOWUPS Item #14 Phase 1 — submit a transfer
   * commitment and classify any non-success / non-idempotent-redirect
   * response. Wraps `stClient.submitTransferCommitment(commitment)`
   * to centralise the
   * `'state-already-spent-by-other'`-vs-`'TRANSFER_FAILED'` decision
   * for the multi-device double-spend scenario.
   *
   * Sequencing:
   *   1. Submit the commitment.
   *   2. If `status ∈ {SUCCESS, REQUEST_ID_EXISTS}` — success arc;
   *      return.
   *   3. Otherwise, before mapping to generic `TRANSFER_FAILED`,
   *      re-query the aggregator: `oracle.isSpent(sourceStateHash)`.
   *      If TRUE, the L3 anchored a competing commit for this source
   *      state — throw `STATE_ALREADY_SPENT_BY_OTHER` with a
   *      structured payload so the dispatcher's outer catch can
   *      emit `transfer:double-spend-detected`.
   *   4. If `isSpent` returns FALSE or throws, fall back to the
   *      legacy generic `TRANSFER_FAILED` so today's behaviour for
   *      transient / verification-failed cases is preserved.
   *
   * `sourceStateHash` is the imprint hex of the commitment's source
   * state — matches the format `oracle.isSpent` expects (same shape
   * the disposition engine threads to `oracleIsSpent` at §5.3 step
   * 7).
   *
   * The caller MUST pass the `tokenId` + `intendedRecipient` strings
   * so the typed error carries the diagnostic payload the dispatcher
   * outer-catch needs to emit the event. The recipient string can be
   * the `directAddress`, `@nametag`, or chain pubkey — whichever
   * the caller has in scope at the throw site.
   */
  private async submitCommitmentClassified(
    stClient: StateTransitionClient,
    oracle: OracleProvider | undefined,
    commitment: TransferCommitment,
    classify: {
      readonly tokenId: string;
      readonly intendedRecipient: string;
    },
  ): Promise<void> {
    const submitResponse = await stClient.submitTransferCommitment(commitment);
    if (
      submitResponse.status === 'SUCCESS' ||
      submitResponse.status === 'REQUEST_ID_EXISTS'
    ) {
      return;
    }

    // Non-success arc — disambiguate "state already spent by another
    // commit" from generic failures via an authoritative oracle
    // re-query against the source state hash.
    let isSpent = false;
    let sourceStateHashHex: string | null = null;
    if (oracle !== undefined && typeof oracle.isSpent === 'function') {
      try {
        const sourceStateHashObj = await commitment.transactionData.sourceState.calculateHash();
        sourceStateHashHex = sourceStateHashObj.toJSON();
        isSpent = await oracle.isSpent(sourceStateHashHex);
      } catch (probeErr) {
        // The probe is best-effort. If it throws (e.g. aggregator
        // offline), we fall through to the generic
        // `TRANSFER_FAILED` rather than emitting a false-positive
        // double-spend event. Operators see the original commit
        // failure in the standard error stream.
        logger.warn(
          'Payments',
          `submitCommitmentClassified: oracle.isSpent probe threw — falling back to generic TRANSFER_FAILED: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`,
        );
      }
    }

    if (isSpent && sourceStateHashHex !== null) {
      // The L3 aggregator anchored a competing commit for this source
      // state. Surface as the typed code so the dispatcher's outer
      // catch can emit `transfer:double-spend-detected` for operator
      // visibility. The structured payload travels through
      // `cause` — read by the outer catch to populate the event
      // payload's `sourceStateHash` and `ourIntendedRecipient`.
      throw new SphereError(
        `Transfer commitment lost race for source state ${sourceStateHashHex.slice(0, 16)}…: ` +
          `aggregator confirmed source token ${classify.tokenId.slice(0, 16)}… is already spent ` +
          `by another commit (submit returned ${submitResponse.status}).`,
        'STATE_ALREADY_SPENT_BY_OTHER',
        {
          tokenId: classify.tokenId,
          sourceStateHash: sourceStateHashHex,
          ourIntendedRecipient: classify.intendedRecipient,
          submitStatus: submitResponse.status,
        },
      );
    }

    throw new SphereError(
      `Transfer commitment failed: ${submitResponse.status}`,
      'TRANSFER_FAILED',
    );
  }

  /**
   * Item #14 Phase 1 — inspect a thrown error from
   * `dispatchUxfConservativeSend` / `dispatchUxfInstantSend`'s outer
   * catch; if it carries the `STATE_ALREADY_SPENT_BY_OTHER` code AND
   * a structured diagnostic payload, emit `transfer:double-spend-detected`
   * for operator visibility.
   *
   * Side-effect only — does NOT rethrow. The caller's surrounding
   * `throw err` propagates the original error to the request site
   * unchanged.
   *
   * Defensive: tolerates missing / partial payload fields (synthesised
   * defaults rather than skipping the emit) so an upstream code-path
   * regression that drops the `cause` payload still surfaces an
   * operator-visible event with the available metadata.
   */
  private emitDoubleSpendDetectedIfApplicable(err: unknown): void {
    if (!(err instanceof SphereError)) return;
    if (err.code !== 'STATE_ALREADY_SPENT_BY_OTHER') return;
    // The classified-submit helper stashed the structured payload via
    // `cause` (redacted into `context` by `SphereError`'s constructor).
    // Read it defensively — a future refactor that drops the cause
    // payload should still surface an event with the available fields.
    const ctx = err.context;
    const payload: SphereEventMap['transfer:double-spend-detected'] = {
      tokenId:
        (ctx as { tokenId?: unknown })?.tokenId !== undefined &&
        typeof (ctx as { tokenId?: unknown }).tokenId === 'string'
          ? ((ctx as { tokenId: string }).tokenId)
          : '',
      sourceStateHash:
        (ctx as { sourceStateHash?: unknown })?.sourceStateHash !== undefined &&
        typeof (ctx as { sourceStateHash?: unknown }).sourceStateHash === 'string'
          ? ((ctx as { sourceStateHash: string }).sourceStateHash)
          : '',
      ourIntendedRecipient:
        (ctx as { ourIntendedRecipient?: unknown })?.ourIntendedRecipient !== undefined &&
        typeof (ctx as { ourIntendedRecipient?: unknown }).ourIntendedRecipient === 'string'
          ? ((ctx as { ourIntendedRecipient: string }).ourIntendedRecipient)
          : '',
      detectedAt: Date.now(),
    };
    try {
      this.deps?.emitEvent('transfer:double-spend-detected', payload);
    } catch (emitErr) {
      // Emitter failures must not mask the original double-spend
      // throw. Log and move on.
      logger.warn(
        'Payments',
        `emitDoubleSpendDetectedIfApplicable: emit threw (swallowed): ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
      );
    }
  }

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
    const signingService = await SigningService.createFromSecret(privateKeyBytes);
    // Side-effect: cache `signingService.publicKey` as lowercase hex so
    // the synchronous `latestStatePredicateMatchesWallet` (called by the
    // PR #146 balance-model invariant in `loadFromStorageData`) can run
    // without async work. The cache is invalidated by `clear()` /
    // identity reset. See `_signingPublicKeyHex` field doc.
    if (this._signingPublicKeyHex === null) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pkBytes = (signingService as any).publicKey;
        if (pkBytes instanceof Uint8Array) {
          this._signingPublicKeyHex = Array.from(pkBytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        }
      } catch {
        // Best-effort. The fallback in latestStatePredicateMatchesWallet
        // uses identity.chainPubkey when this cache stays null.
      }
    }
    return signingService;
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
        // R20 fix: do NOT mark confirmed when finalization can't complete.
        // The token's sdkData still holds the SENDER's state (sender's
        // predicate). Marking 'confirmed' here would let the spend queue
        // pick it for outbound transfers; the resulting commitment's
        // sourceState.predicate would be the sender's pubkey, the
        // authenticator would be ours — predicate.isOwner() returns false
        // and the aggregator throws "Authenticator does not match source
        // state predicate." Leaving status='submitted' makes the spend
        // queue's `status !== 'confirmed'` filter (SpendQueue.ts:91)
        // skip this token until proof+finalize complete.
        logger.warn('Payments', `Cannot finalize - no waitForProofSdk; leaving token ${tokenId.slice(0, 12)}... in 'submitted' status`);
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
        // R20 fix: same rationale as above — do NOT mark confirmed when
        // we can't normalize sdkData to OUR predicate. The spend queue
        // must keep skipping this token.
        logger.warn('Payments', `Cannot finalize - missing stClient/trustBase; leaving token ${tokenId.slice(0, 12)}... in 'submitted' status`);
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
      // R20 fix (PR #130) + #144 steelman FIX H (PR #146): do NOT mark
      // confirmed when finalize throws.
      //
      // Pre-fix, this catch unconditionally flipped status to 'confirmed'
      // — "user has the token" — but `sdkData` was never updated to the
      // finalized state. Any subsequent spend would build a commitment
      // with the SENDER's sourceState predicate while authenticator
      // carried THIS wallet's pubkey, and submitTransferCommitment
      // rejected with "Authenticator does not match source state
      // predicate." The flip also swallowed real integrity failures
      // (trustBase mismatch, predicate validation, invalid proof)
      // leaving a token-shaped placeholder in the active map that fails
      // every subsequent verification while counting toward balance.
      // The restart-recovery path (#144 L1 restoreProofPollingJobs)
      // widens this catch's reach, making the bug user-visible.
      //
      // Fixed behavior: leave the token at its current status (typically
      // 'submitted'/'pending' so the polling queue retries) and emit a
      // typed operator-alert so the UI / support has a signal.
      logger.error('Payments', `Failed to finalize received token ${tokenId.slice(0, 12)}... — leaving status for retry:`, error);
      try {
        this.deps!.emitEvent('transfer:operator-alert', {
          // `proof-throw` matches §5.4's "proof verify threw" — closest
          // canonical DispositionReason for a finalize-side failure that
          // we can't cleanly attribute to one of the structural codes.
          code: 'proof-throw',
          tokenId,
          message:
            `finalizeReceivedToken threw for ${tokenId.slice(0, 12)}...: ` +
            `${(error as Error)?.message ?? String(error)}. ` +
            `Token left at current status for retry by the polling queue.`,
        });
      } catch {
        // Event emitter not wired — log only.
      }
      // Intentionally do NOT mutate token.status here.
    }
  }

  /**
   * Await durability on every TokenStorageProvider that supports
   * `awaitNextFlush()`. Returns `true` iff every provider's flush
   * completed (or it doesn't expose the method — assumed durable on
   * save() return for filesystem-style providers). Used by
   * `handleIncomingTransfer` to gate the Nostr ack on real IPFS pin
   * completion.
   *
   * Failures (POINTER_MONOTONICITY_VIOLATION, IPFS unreachable, OrbitDB
   * write timeout, awaitNextFlush deadline exceeded) are logged at
   * `warn` and surface as `false` so the caller refuses to advance the
   * `since` filter.
   */
  private async awaitAllProvidersDurable(timeoutMs = 60_000): Promise<boolean> {
    const providers = this.getTokenStorageProviders();
    if (providers.size === 0) return true;
    let allDurable = true;
    for (const [providerId, provider] of providers) {
      if (typeof provider.awaitNextFlush !== 'function') continue;
      try {
        await provider.awaitNextFlush(timeoutMs);
      } catch (err) {
        logger.warn(
          'Payments',
          `[AT-LEAST-ONCE] provider ${providerId} awaitNextFlush failed — Nostr event will NOT be acked, replayed on next reconnect:`,
          err instanceof Error ? err.message : err,
        );
        allDurable = false;
      }
    }
    return allDurable;
  }

  /**
   * Process an inbound token-transfer event from the transport layer.
   *
   * Returns `true` if the resulting tokens (if any) are now durably
   * persisted to all configured TokenStorageProviders (specifically:
   * for the Profile provider, this means the IPFS CAR is pinned, the
   * OrbitDB bundle ref is written, and the aggregator pointer is
   * updated). The Nostr transport uses this signal to gate
   * `lastEventTs` advancement — see SPEC §at-least-once-invariant.
   *
   * Returns `false` if:
   *  - the receive pipeline threw (parse / oracle / validation errors)
   *  - any provider's `awaitNextFlush()` rejected (timeout, monotonicity
   *    violation, IPFS unreachable)
   *
   * In either failure case, the transport MUST NOT advance the `since`
   * filter past this event, so the event is re-replayed on the next
   * reconnect. Re-processing is idempotent (addToken dedupes via
   * `(tokenId, stateHash)`; processedCombinedTransferIds dedupes V6
   * bundles).
   */
  private async handleIncomingTransfer(transfer: IncomingTokenTransfer): Promise<boolean> {
    // Drain race fix — count every in-flight receive so the pre-flush
    // drain can wait for the async receive→addToken pipeline to settle
    // before snapshotting the wallet. See `inflightReceiveCount` doc.
    // try/finally ensures the counter balances on EVERY exit path
    // (early-return, thrown error, awaited rejection).
    this.inflightReceiveCount++;
    // At-least-once invariant: track whether the body completed without
    // error so the finally block can decide whether to await durability.
    // Default false — only flipped to true on the happy paths that
    // actually persist a token. Early returns (already-processed dedup,
    // invalid payload format) leave it false; we still treat those as
    // durable since there's nothing new to persist (see below).
    let bodyCompleted = false;
    let nothingToPerist = false;
    try {
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
        // Pool rejected the bundle — no token persisted. Return false so
        // the Nostr ack does NOT advance; the event re-replays on the
        // next reconnect (idempotent via addToken stateHash dedup).
        return false;
      }
      // Pool's enqueue() awaits the worker `settled` promise, so by the
      // time we get here the worker has processed the bundle and addToken
      // ran inside processToken. Now flush to make the token durable in
      // IPFS+OrbitDB+aggregator-pointer before letting the Nostr ack
      // advance.
      return await this.awaitAllProvidersDurable();
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
        let v6Success = true;
        try {
          await this.processCombinedTransferBundle(combinedBundle, transfer.senderTransportPubkey);
          logger.debug('Payments', 'COMBINED_TRANSFER V6 processed successfully');
        } catch (err) {
          logger.error('Payments', 'COMBINED_TRANSFER V6 processing error:', err);
          v6Success = false;
        }
        if (!v6Success) return false;
        // V6 path persists via internal save calls — await flush durability.
        return await this.awaitAllProvidersDurable();
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
          let instantOk = false;
          const result = await this.processInstantSplitBundle(
            instantBundle,
            transfer.senderTransportPubkey,
            payload.memo as string | undefined,
          );
          if (result.success) {
            logger.debug('Payments', 'INSTANT_SPLIT processed successfully');
            instantOk = true;
          } else {
            logger.warn('Payments', 'INSTANT_SPLIT processing failed:', result.error);
          }
          if (!instantOk) return false;
        } catch (err) {
          logger.error('Payments', 'INSTANT_SPLIT processing error:', err);
          return false;
        }
        // INSTANT_SPLIT success — await flush before acking Nostr event.
        return await this.awaitAllProvidersDurable();
      }

      // Check for NOSTR-FIRST commitment-only transfer (whole-token instant send)
      if (payload.sourceToken && payload.commitmentData && !payload.transferTx) {
        logger.debug('Payments', 'NOSTR-FIRST commitment-only transfer detected');
        await this.handleCommitmentOnlyTransfer(transfer, payload);
        // NOSTR-FIRST persists internally — await flush before acking.
        return await this.awaitAllProvidersDurable();
      }

      let tokenData: unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let finalizedSdkToken: SdkToken<any> | null = null;
      // D1 — Track the post-receive status. Defaults to 'confirmed'; the
      // SDK-format path below downgrades to 'pending' when local
      // finalization isn't possible (no proof yet, or finalize throws),
      // so the recovery flow can retry and the balance-model invariant
      // doesn't archive a not-yet-finalized token.
      let receiveStatus: Token['status'] = 'confirmed';

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
          return false;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let sourceToken: SdkToken<any>;
        let transferTx: TransferTransaction;

        try {
          sourceToken = await SdkToken.fromJSON(sourceTokenInput);
        } catch (err) {
          logger.error('Payments', 'Failed to parse sourceToken:', err);
          return false;
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
              return false;
            }

            const response = await stClient.submitTransferCommitment(commitment);
            if (response.status !== 'SUCCESS' && response.status !== 'REQUEST_ID_EXISTS') {
              logger.error('Payments', 'Transfer commitment submission failed:', response.status);
              return false;
            }

            if (!this.deps!.oracle.waitForProofSdk) {
              logger.error('Payments', 'Cannot wait for proof - missing oracle method');
              return false;
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
          return false;
        }

        // Finalize using shared helper (handles PROXY address validation)
        try {
          const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const trustBase = (this.deps!.oracle as any).getTrustBase?.();
          if (!stClient || !trustBase) {
            logger.error('Payments', 'Cannot finalize - missing state transition client or trust base. Token rejected.');
            return false;
          }
          finalizedSdkToken = await this.finalizeTransferToken(sourceToken, transferTx, stClient, trustBase);
          tokenData = finalizedSdkToken.toJSON();
          const addressScheme = transferTx.data.recipient.scheme;
          logger.debug('Payments', `${addressScheme === AddressScheme.PROXY ? 'PROXY' : 'DIRECT'} finalization successful`);
        } catch (finalizeError) {
          logger.error('Payments', 'Finalization FAILED - token rejected:', finalizeError);
          return false;
        }
      } else if (payload.token) {
        // SDK format `{ token, proof? }`. The sender shipped a token JSON.
        //
        // D1 fix (faucet finalization-plan regression). Pre-fix, this path
        // took `payload.token` AS-IS and saved with `status: 'confirmed'`.
        // Producers (faucets and external services) often ship a token
        // whose `state.predicate` still reflects the SENDER's state — they
        // never ran the local `Token.update(...)` that flips ownership to
        // the recipient. Post-PR-#146, such tokens are correctly archived
        // by the balance-model invariant ("state.predicate isn't ours +
        // no finalization plan = move to archive"), making faucet-received
        // tokens invisible to `payments balance`.
        //
        // The fix: inspect the token JSON. If the last transaction is a
        // transfer with an inclusion proof but the local `state.predicate`
        // doesn't reflect our ownership, reconstruct the source token at
        // state N-1 and call `finalizeTransferToken(...)` to produce a
        // token JSON with OUR predicate. Fall back to the as-is path when
        // local finalization can't run (no last tx, no source state in
        // the tx data, no stClient/trustBase, or finalize throws); in
        // that case we additionally classify status='pending' so the
        // recovery flow (`isReceivedLegacyPending` →
        // `recoverStrandedReceivedTokens`) can re-attempt later.
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const tokenJson: any =
            typeof payload.token === 'string'
              ? JSON.parse(payload.token as string)
              : payload.token;
          const txs: unknown[] = Array.isArray(tokenJson?.transactions)
            ? tokenJson.transactions
            : [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lastTxJson: any = txs.length > 0 ? txs[txs.length - 1] : null;
          // Canonical default: missing inclusionProof === null.
          const lastTxProof =
            lastTxJson === null
              ? null
              : lastTxJson.inclusionProof === undefined
                ? null
                : lastTxJson.inclusionProof;
          const lastTxData = lastTxJson?.data;
          const sourceStateJson = lastTxData?.sourceState;
          const stClient = this.deps!.oracle.getStateTransitionClient?.() as
            | StateTransitionClient
            | undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const trustBase = (this.deps!.oracle as any).getTrustBase?.();

          // Heuristic for "needs local finalization": there IS a last
          // transaction, that tx is a transfer (has `data.sourceState`),
          // and the proof is set. If the proof is null/missing, fall
          // through to the as-is path with status='pending' — the
          // recovery flow will retry once the proof lands.
          const canTryFinalize =
            lastTxJson !== null &&
            lastTxProof !== null &&
            sourceStateJson !== undefined &&
            stClient !== undefined &&
            trustBase !== undefined &&
            lastTxData !== null &&
            lastTxData !== undefined;

          if (canTryFinalize) {
            // Quick check: does the token's current state already match
            // our predicate? If yes, no finalization is needed.
            const ourPubkey = this.deps!.identity.chainPubkey?.toLowerCase() ?? '';
            const currentStatePredicate = tokenJson?.state?.predicate;
            const predicateAlreadyOurs =
              typeof currentStatePredicate === 'string' &&
              ourPubkey.length > 0 &&
              currentStatePredicate.toLowerCase().includes(ourPubkey);

            if (predicateAlreadyOurs) {
              tokenData = tokenJson;
            } else {
              // Reconstruct source token at state N-1: same genesis +
              // nametags + version, but `state` is the last-tx
              // sourceState and `transactions` is all-but-last.
              const sourceTokenJson = {
                ...tokenJson,
                state: sourceStateJson,
                transactions: txs.slice(0, -1),
              };
              try {
                const sourceToken = await SdkToken.fromJSON(sourceTokenJson);
                const transferTx = await TransferTransaction.fromJSON(lastTxJson);
                const finalizedToken = await this.finalizeTransferToken(
                  sourceToken,
                  transferTx,
                  stClient!,
                  trustBase,
                );
                tokenData = finalizedToken.toJSON();
                logger.debug(
                  'Payments',
                  'SDK-format local finalization succeeded — state.predicate flipped to recipient',
                );
              } catch (finalizeErr) {
                // Local finalization failed. Save the token as-is but
                // mark pending so the balance-model invariant doesn't
                // archive it and the recovery flow can retry.
                logger.warn(
                  'Payments',
                  `SDK-format local finalization failed (${
                    finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr)
                  }) — saving as-is with status='pending' for recovery`,
                );
                tokenData = tokenJson;
                receiveStatus = 'pending';
              }
            }
          } else {
            // Either no transactions (fresh mint), no sourceState in last
            // tx, no stClient/trustBase, or null proof. Save as-is and
            // mark pending if the proof is null/missing — the recovery
            // flow needs to know finalization is pending. For fresh mints
            // (no txs) or missing-sourceState shapes we preserve the
            // previous status='confirmed' default.
            tokenData = tokenJson;
            if (txs.length > 0 && lastTxProof === null) {
              receiveStatus = 'pending';
            }
          }
        } catch (parseErr) {
          logger.warn(
            'Payments',
            `SDK-format payload.token parse failed (${
              parseErr instanceof Error ? parseErr.message : String(parseErr)
            }) — falling back to as-is`,
          );
          tokenData = payload.token;
        }
      } else {
        logger.warn('Payments', 'Unknown transfer payload format');
        return false;
      }

      // Validate token
      const validation = await this.deps!.oracle.validateToken(tokenData);
      if (!validation.valid) {
        logger.warn('Payments', 'Received invalid token');
        return false;
      }

      // Parse token info from SDK data
      const tokenInfo = await parseTokenInfo(tokenData);

      const token: Token = {
        id: tokenInfo.tokenId ?? crypto.randomUUID(),
        coinId: tokenInfo.coinId,
        symbol: tokenInfo.symbol,
        name: tokenInfo.name,
        decimals: tokenInfo.decimals,
        iconUrl: tokenInfo.iconUrl,
        amount: tokenInfo.amount,
        status: receiveStatus,
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
        // Duplicate via stateHash dedup — the token was already
        // persisted on a prior event. Treat as durable so the Nostr
        // ack can advance.
        nothingToPerist = true;
      }
      bodyCompleted = true;
    } catch (error) {
      logger.error('Payments', 'Failed to process incoming transfer:', error);
      // bodyCompleted stays false → durable=false → ack NOT advanced
    }
    } finally {
      // Drain race fix — counterpart to the entry-side increment. Runs
      // on every exit path (return, throw, normal completion). When
      // this reaches 0, no inbound transfer is mid-pipeline and a
      // pre-flush drain can safely snapshot `this.tokens`.
      this.inflightReceiveCount--;
    }

    // At-least-once invariant: if the body completed and persisted a
    // token, we MUST await flush completion on every provider that
    // supports it before returning durable=true. The transport layer
    // uses our return value to gate `lastEventTs` advancement.
    if (!bodyCompleted) return false;
    if (nothingToPerist) return true;
    return await this.awaitAllProvidersDurable(60_000);
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

    // #143 FIX D — UNION-MERGE tombstones (do NOT replace).
    //
    // Wholesale replacement is unsafe: when a remote/sync snapshot is older
    // than the local set (e.g. an in-flight send tombstoned a source AFTER
    // the snapshot was captured), `this.tombstones = parsed.tombstones`
    // drops the local tombstone. The just-spent source token then re-loads
    // from the snapshot, status='confirmed', and the spend planner sees a
    // phantom balance — the failure mode reported in #143.
    //
    // Union semantics mirror {@link mergeTombstones} (line ~6806). Local
    // tombstones survive sync; remote tombstones are added if not already
    // present. The keySet provides O(1) dedup.
    //
    // Loop1-S10 — build the merged ARRAY in a local first, then assign
    // both `this.tombstones` AND `this.tombstoneKeySet` atomically at
    // the end. The previous revision mutated `this.tombstones` in-place
    // during the loop while reassigning the keySet only AFTER the loop
    // exited; an exception mid-iteration (malformed snapshot, etc.)
    // would leave the two stores divergent until the next
    // `rebuildTombstoneKeySet`. Atomic assignment closes that hazard.
    const mergedKeySet = new Set(this.tombstoneKeySet);
    const mergedArray = [...this.tombstones];
    for (const t of parsed.tombstones) {
      // Defensive: skip malformed entries. A snapshot with a missing
      // tokenId or stateHash would create a "undefined:undefined" key
      // that matches any future token whose extract* returns undefined
      // — silent over-tombstoning.
      if (
        t === null ||
        typeof t !== 'object' ||
        typeof (t as { tokenId?: unknown }).tokenId !== 'string' ||
        typeof (t as { stateHash?: unknown }).stateHash !== 'string'
      ) {
        continue;
      }
      const k = `${t.tokenId}:${t.stateHash}`;
      if (!mergedKeySet.has(k)) {
        mergedArray.push(t);
        mergedKeySet.add(k);
      }
    }
    this.tombstones = mergedArray;
    this.tombstoneKeySet = mergedKeySet;
    // Load tokens, filtering out tombstoned ones.
    //
    // INVARIANT (2026-05-16): load() MUST NEVER drop tokens that exist
    // only in memory. Storage can lag (debounced flush, transient
    // pointer publish failures holding the at-least-once gate closed)
    // while addToken has already committed to `this.tokens`. A
    // wholesale `tokens.clear()` followed by "rebuild from storage"
    // silently wipes any token whose flush hasn't durably completed —
    // even though PaymentsModule originally accepted it. That is the
    // exact failure mode that caused profile-multi-device-sync to lose
    // 4 of 7 faucet drops when transient AGGREGATOR_POINTER_WALKBACK_FLOOR
    // errors held the publish gate closed.
    //
    // Policy:
    //   - Snapshot every in-memory token before clearing.
    //   - Storage data wins for tokens whose (tokenId, stateHash)
    //     identity matches a storage entry. The storage version is
    //     the most-recently-loaded definitive shape (proofs, etc.).
    //   - For every snapshot token that has NO matching storage
    //     entry: re-insert it after the storage load. These are
    //     tokens still in flight from in-memory to storage; dropping
    //     them would lose user state.
    //   - Tombstoned tokens (matching the tombstone set after the
    //     UNION-MERGE above) are dropped from the snapshot —
    //     consistent with the storage-side filter below.
    //
    // The pre-existing 'transferring' preservation guard is now
    // redundant (covered by the broader policy) but kept for clarity
    // at the call site. The newer `preservedFromMemory` map covers
    // every other status — confirmed, unconfirmed, pending, etc.
    const preservedFromMemory = new Map<string, Token>(this.tokens);

    this.tokens.clear();

    // Load other data EARLY so archive-move (below) can write into the
    // up-to-date archive map. Note: `this.nametags` is set further down
    // via the preservation guard so a sync provider that strips _nametags
    // doesn't transiently empty the in-memory nametag set (#136 / PR #140).
    this.archivedTokens = parsed.archivedTokens;
    this.forkedTokens = parsed.forkedTokens;

    let archiveMoved = 0;
    for (const token of parsed.tokens) {
      // Don't overwrite in-flight 'transferring' tokens from the
      // pre-clear snapshot. The broader NEVER-WIPE restore loop
      // below handles every OTHER status, but at the in-loop set
      // stage we still skip storage entries that would clobber a
      // 'transferring' in-flight send (the original guard).
      const existingTransferring = preservedFromMemory.get(token.id);
      if (existingTransferring?.status === 'transferring') continue;

      const sdkTokenId = extractTokenIdFromSdkData(token.sdkData);
      const stateHash = extractStateHashFromSdkData(token.sdkData);

      // Only filter if we have exact state match
      if (sdkTokenId && stateHash && this.isStateTombstoned(sdkTokenId, stateHash)) {
        logger.debug('Payments', `Skipping tombstoned token ${sdkTokenId.slice(0, 8)}... during load (exact state match)`);
        continue;
      }

      // #144 L3 — balance-model invariant: if the latest state's
      // predicate isn't ours AND no finalization plan exists, the token
      // has no place in the active map per #143's mutual-exclusivity
      // refinement. Move it to archive. Bob's stranded V6-direct receive
      // (the #144 reproduction case) is preserved because
      // `isReceivedLegacyPending → hasFinalizationPlan: true`.
      if (
        !this.latestStatePredicateMatchesWallet(token) &&
        !this.hasFinalizationPlan(token)
      ) {
        const txf = tokenToTxf(token);
        if (txf?.genesis?.data?.tokenId) {
          const archiveTokenId = txf.genesis.data.tokenId;
          // Steelman FIX E (#144): the archive map can already contain a
          // record for this tokenId — either from prior archiving (legit
          // history) or from a FORK (different state of same tokenId).
          // Pre-FIX-E we silently overwrote, destroying fork-detection
          // evidence. Now: if archive already has it, skip — the prior
          // record wins. The active-map removal still happens (we don't
          // re-add the token to `this.tokens`). Fork resolution should
          // happen via the explicit `archiveToken()`/`storeForkedToken`
          // flow, not via load-time invariant enforcement.
          if (this.archivedTokens.has(archiveTokenId)) {
            logger.debug(
              'Payments',
              `[BALANCE-INVARIANT] Token ${token.id.slice(0, 12)} ` +
                `already in archive — leaving existing record intact ` +
                `(possible fork or prior archive). Dropping active copy.`,
            );
          } else {
            this.archivedTokens.set(archiveTokenId, txf);
            logger.debug(
              'Payments',
              `[BALANCE-INVARIANT] Moved token ${token.id.slice(0, 12)} to archive — ` +
                `latest state predicate not ours, no finalization plan`,
            );
          }
          archiveMoved++;
          continue;
        }
        // Couldn't convert to TXF — keep in active to avoid data loss.
      }

      this.tokens.set(token.id, token);
    }
    if (archiveMoved > 0) {
      logger.debug(
        'Payments',
        `[BALANCE-INVARIANT] loadFromStorageData moved ${archiveMoved} token(s) to archive`,
      );
    }

    // NEVER-WIPE INVARIANT (2026-05-16): re-insert any token from the
    // pre-clear snapshot that storage did NOT supersede. Storage wins
    // when the same (tokenId, stateHash) identity already loaded —
    // those tokens are NOT restored from the snapshot (the storage
    // version is the canonical one). All other snapshot tokens (those
    // still in flight to storage, or those whose flush failed for any
    // reason) are restored. Tombstoned (tokenId, stateHash) pairs are
    // dropped to stay consistent with the storage-side filter.
    //
    // Build a set of the (tokenId, stateHash) identities now in
    // `this.tokens` from the storage load so the restore loop can
    // dedup cheaply. `Token.id` is internal and can differ between
    // a snapshot entry and a storage entry that represent the SAME
    // logical state — so the comparison MUST go through the SDK-data
    // extractors.
    const loadedStateKeys = new Set<string>();
    for (const t of this.tokens.values()) {
      const tid = extractTokenIdFromSdkData(t.sdkData);
      const sh = extractStateHashFromSdkData(t.sdkData);
      if (tid && sh) loadedStateKeys.add(createTokenStateKey(tid, sh));
    }

    let restoredFromMemory = 0;
    for (const [snapshotId, snapshotToken] of preservedFromMemory) {
      // Skip if storage already loaded a token at this id slot.
      if (this.tokens.has(snapshotId)) continue;

      const snapTokenId = extractTokenIdFromSdkData(snapshotToken.sdkData);
      const snapStateHash = extractStateHashFromSdkData(snapshotToken.sdkData);

      // Tombstoned (tokenId, stateHash) pair → drop (storage tombstone wins).
      if (
        snapTokenId &&
        snapStateHash &&
        this.isStateTombstoned(snapTokenId, snapStateHash)
      ) {
        continue;
      }

      // Storage already has this exact state under a different id slot
      // (rare — happens when storage's internal id differs from the
      // in-memory id for the same logical token). Storage wins.
      if (
        snapTokenId &&
        snapStateHash &&
        loadedStateKeys.has(createTokenStateKey(snapTokenId, snapStateHash))
      ) {
        continue;
      }

      // Snapshot has a NEWER state than what storage loaded for the
      // same tokenId. The newer state was added to memory after the
      // last successful flush and storage hasn't caught up. Archive
      // the older state in `this.tokens` (if present) and restore
      // the newer snapshot — matches addToken's CASE 2 semantics.
      if (snapTokenId) {
        let supersededOlder = false;
        // OUTBOX-SEND-FOLLOWUPS Item #14 Phase 2 work item 5 — JOIN-
        // divergent loser detection. When the preserved-from-memory
        // snapshot token is at status='transferring' (an in-flight
        // send) AND the storage load surfaced a DIFFERENT chain head
        // for the same genesisTokenId, the L3 aggregator has already
        // arbitrated against the local in-flight send (multi-device
        // double-spend race). The storage token is the winner; the
        // snapshot is a stale loser. We drop it (don't restore) and
        // emit `transfer:double-spend-detected` for operator visibility.
        //
        // For non-'transferring' snapshot statuses (e.g. 'confirmed')
        // we preserve the legacy dual-state restore — the spent-state
        // rescan worker (Item #16, default-ON post-soak) catches the
        // off-record spend on its next 5-min probe via
        // `oracle.isSpent` and routes through `defaultSpentStateTransition`.
        let supersededByJoinDivergence = false;
        let winnerStateHash: string | null = null;
        for (const [existingId, existingToken] of this.tokens) {
          if (!hasSameGenesisTokenId(existingToken, snapshotToken)) continue;
          const existingStateHash = extractStateHashFromSdkData(existingToken.sdkData);
          if (
            snapStateHash &&
            existingStateHash &&
            snapStateHash === existingStateHash
          ) {
            // Same exact state — storage's record wins (it was just loaded).
            supersededOlder = true;
            break;
          }
          // Different state. Branch on the snapshot token's status:
          if (snapshotToken.status === 'transferring') {
            // JOIN-divergent loser — drop the snapshot.
            supersededByJoinDivergence = true;
            winnerStateHash = existingStateHash ?? null;
            void existingId; // silence unused-var on the non-debug path
          }
          // Either branch ends the per-token loop — we've found the
          // same-genesisTokenId match.
          break;
        }
        if (supersededOlder) continue;
        if (supersededByJoinDivergence) {
          // Don't restore. The token's value is gone (aggregator
          // anchored the winner's commit; our submit failed at
          // `STATE_ALREADY_SPENT_BY_OTHER` per Item #14 Phase 1).
          //
          // Steelman H1 (PR #182 review): create a tombstone for the
          // dropped loser's (tokenId, stateHash) BEFORE the event
          // emit so a process restart between drop and event-consume
          // leaves a durable audit trail. The tombstone also blocks
          // a stale storage source from re-syncing the dead state
          // back into the active pool on a future load. Same
          // pattern as `removeToken` at line ~9512 — see
          // `createTombstoneFromToken` (line 878).
          const tombstone = createTombstoneFromToken(snapshotToken);
          if (tombstone) {
            const tombKey = `${tombstone.tokenId}:${tombstone.stateHash}`;
            if (!this.tombstoneKeySet.has(tombKey)) {
              this.tombstones.push(tombstone);
              this.tombstoneKeySet.add(tombKey);
            }
          }

          // The recipient field on the loser's bundle is the local
          // intended recipient; we don't have authoritative info on
          // the winning recipient. Emit with empty `ourIntendedRecipient`
          // and `winnerStateHash` so an operator can correlate to
          // the relevant SENT entry / OUTBOX archive if needed.
          //
          // The event matches the Item #14 Phase 1 reactive surface
          // (`transfer:double-spend-detected`) — the reactive surface
          // fires at submit-time, this surface fires at JOIN-time.
          // Operators expect to see the event from EITHER source.
          try {
            this.deps?.emitEvent('transfer:double-spend-detected', {
              tokenId: snapTokenId ?? '',
              sourceStateHash: snapStateHash ?? '',
              ourIntendedRecipient: '',
              detectedAt: Date.now(),
            });
          } catch (emitErr) {
            logger.warn(
              'Payments',
              `loadFromStorageData: emit transfer:double-spend-detected failed for token ${snapshotId.slice(0, 12)}…: ${emitErr instanceof Error ? emitErr.message : String(emitErr)}`,
            );
          }
          logger.debug(
            'Payments',
            `loadFromStorageData: JOIN-divergent loser dropped (tokenId=${snapTokenId?.slice(0, 16)}…, ` +
              `loser-stateHash=${snapStateHash?.slice(0, 16)}…, winner-stateHash=${winnerStateHash?.slice(0, 16) ?? '?'}…, ` +
              `snapshotId=${snapshotId.slice(0, 12)}…, tombstoned=${tombstone !== null}). Item #14 Phase 2 work item 5 — multi-device double-spend race.`,
          );
          continue;
        }
      }

      this.tokens.set(snapshotId, snapshotToken);
      restoredFromMemory++;
    }
    if (restoredFromMemory > 0) {
      logger.debug(
        'Payments',
        `[NEVER-WIPE] loadFromStorageData restored ${restoredFromMemory} in-memory ` +
          `token(s) not present in storage (likely in-flight or flush-stalled)`,
      );
    }

    // Nametag preservation guard (#136). Some sync providers strip
    // `_nametags` from merged data — overriding would transiently empty
    // `this.nametags` and any concurrent `finalizeTransferToken` would
    // throw "no Unicity ID token". Only override when the incoming data
    // actually carries nametag information. An explicit `_nametags: []`
    // (or legacy `_nametag`) from a different device still clears, as
    // expected.
    const rawData = data as unknown as Record<string, unknown>;
    const incomingHasNametags =
      Array.isArray(rawData._nametags) || rawData._nametag != null;
    if (incomingHasNametags || this.nametags.length === 0) {
      this.nametags = parsed.nametags;
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
    // Persist for restart recovery (#144 L1). Fire-and-forget — the job is
    // already in-memory, so a persist failure only affects restart recovery.
    if (job.sourceTokenJson) {
      this.saveProofPollingJobs().catch((err) =>
        logger.debug('Payments', '[V6-PERSIST] saveProofPollingJobs after add failed:', err)
      );
    }
  }

  /**
   * Persist the current set of proof-polling jobs to KV storage. Only jobs
   * that have a `sourceTokenJson` (i.e. V6-direct receive jobs) are
   * eligible for restart recovery — others are skipped. See #144.
   *
   * Keyed by genesis tokenId + state hash, not in-memory UUID, because
   * after save→load the in-memory id is replaced by the genesis tokenId
   * (see `txfToToken` in `serialization/txf-serializer.ts`).
   */
  private async saveProofPollingJobs(): Promise<void> {
    const persisted: PersistedProofPollingJob[] = [];
    for (const [tokenId, job] of this.proofPollingJobs) {
      if (!job.sourceTokenJson) continue;
      const token = this.tokens.get(tokenId);
      // Token may be absent if the job was just added in this tick and the
      // map mutated concurrently. Use the job's stored sdkData as the
      // canonical source of genesis+state info — it's the same value that
      // was written to `Token.sdkData` at create time.
      const sourceTokenJson = job.sourceTokenJson;
      const genesisTokenId = token
        ? extractTokenIdFromSdkData(token.sdkData)
        : extractTokenIdFromSdkData(sourceTokenJson);
      const stateHash = token
        ? extractStateHashFromSdkData(token.sdkData)
        : extractStateHashFromSdkData(sourceTokenJson);
      if (!genesisTokenId || !stateHash) {
        logger.debug(
          'Payments',
          `[V6-PERSIST] Skipping job for ${tokenId.slice(0, 12)} — missing genesisTokenId or stateHash`
        );
        continue;
      }
      persisted.push({
        genesisTokenId,
        stateHash,
        requestIdHex: job.requestIdHex,
        commitmentJson: job.commitmentJson,
        sourceTokenJson,
        startedAt: job.startedAt,
        attemptCount: job.attemptCount,
        lastAttemptAt: job.lastAttemptAt,
        // Steelman FIX G (#144): persist cumulative attempts across
        // process lifetimes. The session's current `attemptCount` is
        // ADDED to the previously-persisted total at restore time, so
        // we save the running total here (= prior + current).
        cumulativeAttempts: (job.cumulativeAttempts ?? 0) + job.attemptCount,
      });
    }

    if (persisted.length === 0) {
      // Clear the KV entry when no eligible jobs remain. Use storage.remove
      // when available so a stale list doesn't survive.
      const storage = this.deps!.storage;
      const removeFn = (storage as { remove?: (k: string) => Promise<void> }).remove;
      if (typeof removeFn === 'function') {
        await removeFn.call(storage, STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS);
      } else {
        await this.setStorageEntry(
          STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS,
          '[]',
          'cache_index'
        );
      }
      return;
    }

    await this.setStorageEntry(
      STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS,
      JSON.stringify(persisted),
      'cache_index'
    );
  }

  /**
   * Restore proof-polling jobs from KV storage. Called from `load()` AFTER
   * `loadFromStorageData` populates `this.tokens`, so we can resolve a
   * persisted `(genesisTokenId, stateHash)` pair to the post-load in-memory
   * `Token.id` (which is the genesis tokenId itself, courtesy of
   * `txfToToken`).
   *
   * Each restored job runs with `attemptCount: 0` — the prior process's
   * attempts don't carry over, so a job that nearly timed out gets a fresh
   * 60s budget instead of being immediately discarded.
   */
  private async restoreProofPollingJobs(): Promise<void> {
    const data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS);
    if (!data) return;

    let persisted: PersistedProofPollingJob[];
    try {
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) {
        logger.error('Payments', '[V6-RESTORE] Persisted jobs is not an array; clearing');
        return;
      }
      persisted = parsed as PersistedProofPollingJob[];
    } catch (err) {
      logger.error('Payments', '[V6-RESTORE] Failed to parse persisted jobs:', err);
      return;
    }

    if (persisted.length === 0) return;

    let restored = 0;
    for (const p of persisted) {
      if (
        !p.genesisTokenId ||
        !p.stateHash ||
        !p.requestIdHex ||
        !p.commitmentJson ||
        !p.sourceTokenJson
      ) {
        logger.debug('Payments', '[V6-RESTORE] Skipping malformed persisted job');
        continue;
      }

      // Find matching in-memory token by genesis tokenId + state hash.
      let memoryTokenId: string | null = null;
      for (const [id, token] of this.tokens) {
        const tid = extractTokenIdFromSdkData(token.sdkData);
        const sh = extractStateHashFromSdkData(token.sdkData);
        if (tid === p.genesisTokenId && sh === p.stateHash) {
          memoryTokenId = id;
          break;
        }
      }
      if (!memoryTokenId) {
        logger.debug(
          'Payments',
          `[V6-RESTORE] No matching token for job ` +
            `(genesisTokenId=${p.genesisTokenId.slice(0, 12)}, ` +
            `stateHash=${p.stateHash.slice(0, 12)}), dropping`
        );
        continue;
      }

      // Already finalized in a prior session? Skip.
      const existingToken = this.tokens.get(memoryTokenId);
      if (existingToken && existingToken.status === 'confirmed') {
        logger.debug(
          'Payments',
          `[V6-RESTORE] Token ${memoryTokenId.slice(0, 12)} already confirmed, skipping job`
        );
        continue;
      }

      // Steelman FIX G (#144): cumulative-attempts cap. If this token
      // has already burned through MAX_CUMULATIVE_ATTEMPTS across
      // prior process lifetimes, mark it invalid and skip restoration.
      // Without this cap, every restart hands the same stuck token a
      // fresh 60s budget — an unbounded zombie loop.
      const cumulativeSoFar = p.cumulativeAttempts ?? 0;
      if (cumulativeSoFar >= PaymentsModule.PROOF_POLLING_MAX_CUMULATIVE_ATTEMPTS) {
        logger.debug(
          'Payments',
          `[V6-RESTORE] Token ${memoryTokenId.slice(0, 12)} ` +
            `exceeded cumulative attempt cap (${cumulativeSoFar} >= ` +
            `${PaymentsModule.PROOF_POLLING_MAX_CUMULATIVE_ATTEMPTS}) — marking invalid`,
        );
        if (existingToken && (existingToken.status === 'submitted' || existingToken.status === 'pending')) {
          existingToken.status = 'invalid';
          existingToken.updatedAt = Date.now();
          this.tokens.set(memoryTokenId, existingToken);
        }
        try {
          this.deps!.emitEvent('transfer:operator-alert', {
            // Same canonical reason as per-process timeout — the
            // proof never anchored after multiple polling windows.
            code: 'oracle-rejected',
            tokenId: memoryTokenId,
            message:
              `Token ${memoryTokenId.slice(0, 12)}... exceeded cumulative ` +
              `proof-polling attempts (${cumulativeSoFar}). Marked invalid; ` +
              `no further automatic recovery attempts will run for this token.`,
          });
        } catch { /* event emitter not wired */ }
        continue;
      }

      let sourceTokenInput: unknown;
      let commitmentInput: unknown;
      try {
        sourceTokenInput = JSON.parse(p.sourceTokenJson);
        commitmentInput = JSON.parse(p.commitmentJson);
      } catch (err) {
        logger.error(
          'Payments',
          `[V6-RESTORE] Failed to parse source/commitment for ${p.genesisTokenId.slice(0, 12)}:`,
          err
        );
        continue;
      }

      this.proofPollingJobs.set(memoryTokenId, {
        tokenId: memoryTokenId,
        requestIdHex: p.requestIdHex,
        commitmentJson: p.commitmentJson,
        sourceTokenJson: p.sourceTokenJson,
        startedAt: p.startedAt,
        attemptCount: 0, // reset for the current session
        lastAttemptAt: 0,
        cumulativeAttempts: cumulativeSoFar, // preserve cross-session total
        onProofReceived: async (tid) => {
          await this.finalizeReceivedToken(tid, sourceTokenInput, commitmentInput);
        },
      });
      restored++;
    }

    if (restored > 0) {
      logger.debug(
        'Payments',
        `[V6-RESTORE] Restored ${restored} proof-polling job(s) from storage`
      );
      this.startProofPolling();
    }
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
          // Mark token as invalid due to timeout.
          // Steelman FIX C (#144): widen to include 'pending' — RECEIVE
          // jobs target status='pending' tokens, and pre-fix the timeout
          // never marked them invalid, leaving them at 'pending' forever
          // and re-triggering `recoverStrandedReceivedTokens` on every
          // load (zombie loop).
          const token = this.tokens.get(tokenId);
          if (token && (token.status === 'submitted' || token.status === 'pending')) {
            token.status = 'invalid';
            token.updatedAt = Date.now();
            this.tokens.set(tokenId, token);
            // Surface to operator/UI: the token's proof never arrived.
            // Without this, the only signal is a debug-level log line.
            try {
              this.deps!.emitEvent('transfer:operator-alert', {
                // `oracle-rejected` per §6.1: "sustained PATH_NOT_INCLUDED
                // past the polling window — the commitment was never
                // anchored". Closest canonical reason for proof-polling
                // timeout exhaustion.
                code: 'oracle-rejected',
                tokenId,
                message:
                  `Proof polling for token ${tokenId.slice(0, 12)}... ` +
                  `exhausted ${PaymentsModule.PROOF_POLLING_MAX_ATTEMPTS} attempts ` +
                  `(~${(PaymentsModule.PROOF_POLLING_MAX_ATTEMPTS * PaymentsModule.PROOF_POLLING_INTERVAL_MS) / 1000}s). ` +
                  `Marked invalid; the aggregator never returned an inclusion proof. ` +
                  `Manual retry via sphere.payments.sync() may help if the proof becomes available later.`,
              });
            } catch {
              // Event emitter not wired or threw — log only.
            }
          }
          completedJobs.push(tokenId);
          continue;
        }

        // Try to get proof with a quick timeout (non-blocking check).
        //
        // #144 L3: jobs registered via `recoverStrandedReceivedTokens`
        // have an empty `commitmentJson` (we can't reconstruct the
        // sender's authenticator). For those, fall back to the
        // `getProof(requestIdHex)` path directly — no commitment needed.
        let inclusionProof: unknown = null;
        try {
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), 500);

          if (job.commitmentJson && this.deps!.oracle.waitForProofSdk) {
            const commitment = await TransferCommitment.fromJSON(JSON.parse(job.commitmentJson));
            inclusionProof = await Promise.race([
              this.deps!.oracle.waitForProofSdk(commitment, abortController.signal),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
            ]);
          } else {
            // Fallback: use getProof with request ID hex (also the only
            // path for #144 L3 migration jobs).
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

        // Proof received! Steelman FIX B (#144): distinguish SEND vs
        // RECEIVE jobs.
        //   - SEND jobs (no `sourceTokenJson`): the sender's outbound
        //     commitment was confirmed → flip token to 'spent' here.
        //   - RECEIVE jobs (`sourceTokenJson` set — V6-direct or L3
        //     migration): leave status='pending' and let
        //     `onProofReceived` (`finalizeReceivedToken` /
        //     `finalizeStrandedReceivedToken`) be the SOLE status
        //     writer. If `onProofReceived` throws, the token stays
        //     'pending' so the next tick (or next process's
        //     recoverStrandedReceivedTokens) can retry. Without this
        //     guard, a finalize throw would permanently freeze the token
        //     at 'spent' — un-recoverable, because
        //     `recoverStrandedReceivedTokens` requires status='pending'.
        const token = this.tokens.get(tokenId);
        const isReceiveJob = !!job.sourceTokenJson;
        if (token && !isReceiveJob) {
          token.status = 'spent';
          token.updatedAt = Date.now();
          this.tokens.set(tokenId, token);
          await this.save();
          logger.debug('Payments', `Proof received for token ${tokenId.slice(0, 8)}..., status: spent`);
        }

        // Await the finalize callback so a throw is observable; on
        // success the queue removes the job, on failure the job stays
        // for retry. (Pre-FIX-B: callback was fire-and-forget AND the
        // job was unconditionally removed via completedJobs.push — both
        // bugs, both fixed here.)
        let callbackOk = true;
        try {
          await job.onProofReceived?.(tokenId);
        } catch (cbErr) {
          callbackOk = false;
          logger.error(
            'Payments',
            `onProofReceived for ${tokenId.slice(0, 8)}... threw — keeping job for retry:`,
            cbErr,
          );
        }
        if (callbackOk) {
          completedJobs.push(tokenId);
        }
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

    // Persist updated queue (attempt counts changed; some jobs removed).
    // Fire-and-forget — in-memory state is authoritative for this process.
    this.saveProofPollingJobs().catch((err) =>
      logger.debug('Payments', '[V6-PERSIST] saveProofPollingJobs after tick failed:', err)
    );
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
  /**
   * Task #169 — Optional cancellation signal. Wired to the
   * FinalizationWorkerSender's `signal` option AND through to the
   * `sleep` adapter. The worker honors `signal.aborted` between
   * aggregator calls and the sleep adapter rejects pending timers
   * on abort. PaymentsModule.destroy() aborts the parent controller
   * BEFORE awaiting `worker.stop()` so in-flight cycles terminate
   * deterministically rather than running orphaned to completion.
   */
  readonly signal?: AbortSignal;
  /**
   * Round 7 (FIX 3) — Optional shared {@link PerTokenMutex} so the
   * sender worker, recipient worker, and operator escape-hatch
   * InclusionProofImporter serialize against the same read-decide-write
   * window when they touch the same tokenId. When omitted, a fresh
   * per-builder mutex is used (the previous default — preserves
   * backward compatibility for callers that don't share).
   */
  readonly perTokenMutex?: PerTokenMutex | null;
}): FinalizationWorkerSender {
  const { addressId, oracle, senderOutboxMap, senderRequestContextMap, emit, signal } = opts;

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
        // Task #152 — Build AnchoredProofDescriptor from the oracle's
        // InclusionProof. The aggregator's `proof.proof` field carries
        // the canonical IInclusionProofJson shape:
        //   { merkleTreePath, authenticator, transactionHash, unicityCertificate }
        // where `transactionHash` is the SDK-encoded DataHash imprint hex
        // (68 chars for sha2-256) or null for path-non-inclusion proofs,
        // and `authenticator` is an IAuthenticatorJson object or null.
        //
        // Race-lost detection (§6.1) compares the proof's transactionHash
        // against the locally-stored `_senderRequestContextMap` value
        // populated by `commitSources` from `commitment.transactionData
        // .calculateHash()`. Both sides MUST use the same imprint hex —
        // before this fix both sides used the requestId, which always
        // matched, making the detector dead in production.
        const proofJson = proof.proof as
          | {
              transactionHash?: string | null;
              authenticator?: unknown;
            }
          | null
          | undefined;
        // Wave 4 fix — classify path-non-inclusion (transactionHash === null)
        // BEFORE constructing the OK descriptor. Per SDK semantics a proof
        // with `transactionHash: null` is a cryptographic proof of NON-
        // inclusion at this SMT snapshot, not a successful proof. Treat as
        // PATH_NOT_INCLUDED so the worker continues polling within the
        // window (§6.1) instead of triggering race-lost when the OK
        // descriptor's transactionHash falls back to the requestId
        // (different from the local 68-char imprint by construction).
        if (proofJson !== null && proofJson !== undefined && proofJson.transactionHash === null) {
          return { kind: 'PATH_NOT_INCLUDED' };
        }
        const proofTxHash =
          proofJson !== null && proofJson !== undefined && typeof proofJson.transactionHash === 'string'
            ? proofJson.transactionHash
            : null;
        const proofAuthenticator =
          proofJson !== null && proofJson !== undefined && proofJson.authenticator !== undefined && proofJson.authenticator !== null
            ? JSON.stringify(proofJson.authenticator)
            : '';
        // Fallback for path-non-inclusion proofs (transactionHash is null
        // by spec). The Wave 4 early-return above already classifies
        // those as PATH_NOT_INCLUDED, so this fallback handles only the
        // degenerate case where proofJson is null/undefined entirely
        // (which should not happen given the upstream shape validation,
        // but keeps the descriptor a valid string for type safety).
        const descriptor: import('./transfer/finalization-worker-base').AnchoredProofDescriptor = {
          transactionHash: proofTxHash ?? proof.requestId,
          authenticator: proofAuthenticator,
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
  // Round 7 (FIX 3) — accept a shared instance from the caller so the
  // sender worker, recipient worker, and operator escape-hatch importer
  // serialize against the same per-tokenId mutex within the
  // PaymentsModule lifecycle. Falls back to a fresh per-builder mutex
  // if the caller doesn't pass one.
  const perTokenMutex = opts.perTokenMutex ?? new PerTokenMutex();

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
    sleep: (ms: number, abortSignal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        const timer = setTimeout(resolve, ms);
        abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      }),
    // Task #169 — wire the parent AbortController's signal so destroy()
    // can cancel in-flight runFinalizationCycle invocations + sleep
    // timers. The worker's runFinalizationCycle inspects
    // `ctx.signal?.aborted` between aggregator calls; the sleep adapter
    // above also respects the signal for pending timers.
    ...(signal !== undefined ? { signal } : {}),
  });
}

// =============================================================================
// Task #151 — Default FinalizationWorkerRecipient factory
// =============================================================================

/**
 * Build the default auto-installed {@link FinalizationWorkerRecipient}
 * for {@link PaymentsModule.initialize}.
 *
 * Uses lightweight in-memory adapters for the
 * pool/manifest/tombstone/queue 4-step write order (no OrbitDB
 * required). Sufficient to drive the §6.1 cycle to completion and
 * flip Bob's pending tokens to confirmed once the proof lands.
 *
 * Bypasses the full §5.5 step 9 [B]/[D]/[E] re-evaluation: the
 * stub revaluateHooks build always says VALID. The real production
 * harness (bootstrap-injected) plugs in proper hydrateChain /
 * evaluatePredicate / oracleIsSpent against the local manifest.
 *
 * The dispositionWriter callback is the load-bearing path: when the
 * worker writes a VALID disposition (which our stub revaluator
 * always does on success), the callback rebuilds the SDK Token via
 * `finalizeTransferToken`, overwrites the locally-stored Token's
 * sdkData, and flips status to `'confirmed'`.
 *
 * @internal — exported only for unit-test access.
 */
export function buildDefaultFinalizationWorkerRecipient(opts: {
  readonly addressId: string;
  readonly oracle: import('../../oracle').OracleProvider;
  readonly recipientRequestContextMap: Map<string, RequestContext>;
  readonly recipientFinalizationContext: Map<string, RecipientFinalizationContext>;
  readonly tokens: Map<string, Token>;
  readonly finalizeTransferToken: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sourceToken: SdkToken<any>,
    transferTx: TransferTransaction,
    stClient: StateTransitionClient,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trustBase: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<SdkToken<any>>;
  readonly getStateTransitionClient: () => StateTransitionClient | undefined;
  readonly getTrustBase: () => unknown;
  readonly save: () => Promise<void>;
  readonly emit: <T extends import('../../types').SphereEventType>(
    type: T,
    data: import('../../types').SphereEventMap[T],
  ) => void;
  readonly signal?: AbortSignal;
  /**
   * Round 7 (FIX 3) — Optional shared {@link PerTokenMutex} so the
   * recipient worker, sender worker, and operator escape-hatch
   * InclusionProofImporter serialize against the same read-decide-write
   * window when they touch the same tokenId. When omitted, a fresh
   * per-builder mutex is used.
   */
  readonly perTokenMutex?: PerTokenMutex | null;
  /**
   * G3 — Optional persisted {@link FinalizationQueueStorage} for the
   * recipient FinalizationQueue. When omitted, an in-memory shim is used
   * (legacy behavior — does NOT survive Sphere.destroy() / restart). The
   * Sphere bootstrap layer plugs an `OrbitDbFinalizationQueueStorageAdapter`
   * here when a Profile-backed storage stack is detected, closing the
   * cross-restart safety net for the recipient worker.
   */
  readonly finalizationQueueStorage?: import('./transfer/finalization-queue').FinalizationQueueStorage;
}): {
  worker: FinalizationWorkerRecipient;
  queue: FinalizationQueue;
  dispositionWriter: FinalizationDispositionWriter;
  /**
   * Wave 7 hygiene: clears the closure-local `saveFailureStreak` Map.
   * The streak entries are otherwise per-tokenId and only cleaned on
   * save success — so a token that fails save then leaves the wallet
   * (tombstone, deletion, address switch) leaves a dead streak entry.
   * destroy() and similar instance-cleanup paths invoke this to keep
   * the closure's memory bounded.
   */
  clearSaveFailureStreak: () => void;
} {
  const {
    addressId,
    oracle,
    recipientRequestContextMap,
    recipientFinalizationContext,
    tokens,
    finalizeTransferToken,
    getStateTransitionClient,
    getTrustBase,
    save,
    emit,
    signal,
    finalizationQueueStorage,
  } = opts;

  // ---- FinalizationQueue (T.5.C / Wave G.7) --------------------------
  // G3: prefer the caller-supplied persisted storage (Profile/OrbitDb-
  // backed) over the in-memory shim. Sphere wires the persisted form
  // when a ProfileStorageProvider is present; legacy callers fall back
  // to the in-memory map (loss-prone across Sphere.destroy()/restart).
  let queueStorage: import('./transfer/finalization-queue').FinalizationQueueStorage;
  if (finalizationQueueStorage !== undefined) {
    queueStorage = finalizationQueueStorage;
  } else {
    const queueMap = new Map<string, string>();
    queueStorage = {
      async readKey(key: string): Promise<string | null> {
        return queueMap.has(key) ? (queueMap.get(key) ?? null) : null;
      },
      async writeKey(key: string, value: string): Promise<void> {
        queueMap.set(key, value);
      },
      async listByPrefix(prefix: string): Promise<Map<string, string>> {
        const out = new Map<string, string>();
        for (const [k] of queueMap) {
          if (k.startsWith(prefix)) out.set(k, k.slice(prefix.length));
        }
        return out;
      },
      async deleteKey(key: string): Promise<void> {
        queueMap.delete(key);
      },
    };
  }
  const queue = new FinalizationQueue({ storage: queueStorage });

  const queueAdapter = {
    async hasEntry(addr: string, requestId: string): Promise<boolean> {
      return queue.hasEntry(addr, requestId);
    },
    async removeEntry(addr: string, requestId: string): Promise<void> {
      await queue.remove(addr, requestId);
    },
  };

  // ---- Resolver: pulls per-requestId context populated at enqueue ----
  const resolver: RequestContextResolver = {
    async resolve(input) {
      return recipientRequestContextMap.get(input.requestId) ?? null;
    },
  };

  // ---- Pool / poolRead — track attached proofs per (tokenId, reqId) --
  const proofAttached = new Set<string>();
  const poolProofs = new Map<
    string,
    import('./transfer/finalization-worker-base').AnchoredProofDescriptor
  >();
  const pool = {
    async isProofAttached(tokenId: string, reqId: string): Promise<boolean> {
      return proofAttached.has(`${tokenId}:${reqId}`);
    },
    async attachProof(tokenId: string, reqId: string): Promise<void> {
      proofAttached.add(`${tokenId}:${reqId}`);
    },
  };
  const poolRead = {
    async getAttachedProof(
      tokenId: string,
      reqId: string,
    ): Promise<
      import('./transfer/finalization-worker-base').AnchoredProofDescriptor | null
    > {
      return poolProofs.get(`${tokenId}:${reqId}`) ?? null;
    },
  };

  // ---- ManifestCas + tombstones — in-memory ---------------------------
  const manifestEntries = new Map<
    string,
    import('../../profile/token-manifest').TokenManifestEntry
  >();
  const manifestStorage: MinimalManifestStorage = {
    async readEntry(addr, tokenId) {
      return manifestEntries.get(`${addr}:${tokenId}`);
    },
    async writeEntry(addr, tokenId, entry) {
      manifestEntries.set(`${addr}:${tokenId}`, entry);
    },
  };
  const manifestCas = new ManifestCas(manifestStorage);

  const tombstoneSet = new Set<string>();
  const tombstones = {
    async hasTombstone(tokenId: string, cid: ContentHash): Promise<boolean> {
      return tombstoneSet.has(`${tokenId}:${cid}`);
    },
    async insertTombstone(tokenId: string, cid: ContentHash): Promise<void> {
      tombstoneSet.add(`${tokenId}:${cid}`);
    },
  };

  // ---- Aggregator client ---------------------------------------------
  const aggregatorClient = {
    async submit(_input: {
      readonly addressId: string;
      readonly tokenId: string;
      readonly requestId: string;
      readonly signedTx: unknown;
    }): Promise<SubmitOutcome> {
      return { kind: 'REQUEST_ID_EXISTS' };
    },
    async poll(input: {
      readonly addressId: string;
      readonly tokenId: string;
      readonly requestId: string;
      readonly signedTx: unknown;
    }): Promise<PollOutcome> {
      try {
        const proof = await oracle.getProof(input.requestId);
        if (proof === null || proof === undefined) {
          return { kind: 'TRANSIENT' };
        }
        const proofJson = proof.proof as
          | { transactionHash?: string | null; authenticator?: unknown }
          | null
          | undefined;
        // Wave 4 fix — if the aggregator returned an inclusion-proof shape
        // with `transactionHash === null`, that is the SDK's canonical
        // path-non-inclusion proof (a cryptographic proof that the
        // requestId is NOT in the SMT at this snapshot). Treat as
        // PATH_NOT_INCLUDED so the worker keeps polling within the
        // window instead of taking the OK branch — which would then
        // (a) descriptor.transactionHash falls back to requestId and
        // (b) §6.1 race-lost fires because the local context has the
        // canonical 68-char imprint, not the requestId. This was the
        // regression introduced by Wave 1 #157 (shape validation
        // accepting null transactionHash) combined with Wave 2 #151
        // (recipient worker bootstrap).
        if (proofJson !== null && proofJson !== undefined && proofJson.transactionHash === null) {
          return { kind: 'PATH_NOT_INCLUDED' };
        }
        const proofTxHash =
          proofJson !== null && proofJson !== undefined && typeof proofJson.transactionHash === 'string'
            ? proofJson.transactionHash
            : null;
        const proofAuthenticator =
          proofJson !== null && proofJson !== undefined && proofJson.authenticator !== undefined && proofJson.authenticator !== null
            ? JSON.stringify(proofJson.authenticator)
            : '';
        const descriptor: import('./transfer/finalization-worker-base').AnchoredProofDescriptor = {
          transactionHash: proofTxHash ?? proof.requestId,
          authenticator: proofAuthenticator,
          roundNumber: proof.roundNumber,
          proof: proof.proof,
        };
        poolProofs.set(`${input.tokenId}:${input.requestId}`, descriptor);
        // Issue #195: do NOT synthesize a placeholder manifest entry here.
        // The §5.5 step 5 4-step write order assigns ownership of the
        // manifest entry to step 2 (`step2ManifestCidRewrite`). The
        // recipient enqueue path populates `RequestContext` with
        // `previousCid: undefined` (genesis), which step 2 translates to
        // `prev = null` (assert "no entry exists"). Writing a placeholder
        // here before step 2 runs breaks that contract — `manifestCas.update`
        // observes the placeholder, returns `cas-mismatch` (placeholder
        // ≠ undefined), and step 2 throws `ManifestCidRewriteCasError`.
        //
        // The escrow swap deposit flow surfaces this most visibly: the
        // CAS error blocks the deposit token from flipping to
        // `'confirmed'`, leaving the swap stuck at `PARTIAL_DEPOSIT`
        // with no progression to payout. Real receives are also broken;
        // they only "work" because the local Token still appears in the
        // UI and casual flows tolerate the silently stuck pending state.
        //
        // Removing this write lets step 2's CAS execute cleanly: it
        // observes `undefined`, accepts the `prev = null` assertion,
        // and inserts the canonical first entry via `writeEntry`.
        const newCid = contentHash(
          input.requestId.replace(/[^0-9a-f]/gi, '').padStart(64, '0').slice(0, 64),
        );
        return { kind: 'OK', proof: descriptor, newCid };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: 'TRANSIENT', error: `oracle.getProof threw: ${message}` };
      }
    },
  };

  // ---- Per-token semaphores + per-token mutex ------------------------
  const perTokenSemaphores = new Map<string, CountingSemaphore>();
  const getPerTokenSemaphore = (tokenId: string): CountingSemaphore => {
    let sem = perTokenSemaphores.get(tokenId);
    if (sem === undefined) {
      sem = new CountingSemaphore(4);
      perTokenSemaphores.set(tokenId, sem);
    }
    return sem;
  };
  // Round 7 (FIX 3) — share with sender worker + operator importer so
  // concurrent paths on the same tokenId serialize against the same
  // read-decide-write window. Falls back to a fresh per-builder mutex
  // if the caller doesn't pass one.
  const perTokenMutex = opts.perTokenMutex ?? new PerTokenMutex();

  // ---- Stub CascadeWalker (no children scan, no NFT routing) ---------
  const cascadeManifestScanner: CascadeManifestScanner = {
    async readEntry(addr, tokenId) {
      return manifestEntries.get(`${addr}:${tokenId}`);
    },
    async findChildren(_addr, _parentTokenId) {
      return [];
    },
  };
  const cascadeOutboxScanner: CascadeOutboxScanner = {
    async findEntriesByTokenId() {
      return [];
    },
  };
  const classifyTokenLookup: ClassifyTokenLookup = async () => null;
  const cascadeWalker = new CascadeWalker({
    manifestScanner: cascadeManifestScanner,
    manifestCas,
    outboxScanner: cascadeOutboxScanner,
    classifyToken: classifyTokenLookup,
    emit,
  });

  // ---- Stub revaluateHooks (always VALID) ----------------------------
  const ourPubkey = new Uint8Array(33);
  ourPubkey[0] = 0x02;
  const revaluateHooks: RevaluateHooksProvider = {
    async buildRevaluateInput(_addr, tokenId) {
      const newHead = contentHash(('11'.repeat(32)).slice(0, 64));
      return {
        tokenRootHash: newHead,
        pool: new Map(),
        bundleCidForProvenance: 'task-151-stub',
        senderTransportPubkeyForProvenance: '',
        ourPubkey,
        async hydrateChain() {
          return {
            tokenId,
            tokenRootHash: newHead,
            chain: [
              {
                sourceState: 's0',
                destinationState: 's1',
                authenticator: { stub: true },
                transactionHash: { stub: true },
                inclusionProof: { stub: true },
                requestId: { stub: true },
              },
            ],
            currentStatePredicate: { stub: true },
            currentDestinationStateHash: 'stub-state-head',
          };
        },
        async readLocalManifest() {
          return undefined;
        },
        async evaluatePredicate() {
          return { ok: true, bindsToUs: true };
        },
        async oracleIsSpent() {
          return false;
        },
      };
    },
  };

  // ---- DispositionWriter — load-bearing finalization callback --------
  //
  // Wave 4 fix — every error path emits `transfer:operator-alert` so the
  // local Token doesn't silently stay 'pending' forever when the
  // recipient finalization fails. The previous Wave 2 implementation
  // swallowed errors in the catch block, which combined with the
  // race-lost regression made stuck tokens invisible to operators.
  //
  // Design choice: ctx is intentionally NOT removed on failure — that
  // way a subsequent retry (e.g. via payments.receive({finalize:true})
  // or a manual disposition replay) can pick up the same context. The
  // leak is bounded because `recipientFinalizationContext` is a
  // per-instance Map cleared on `destroy()` and on successful
  // finalization.
  //
  // Wave 6 steelman fix — alert flood backoff for save() failures.
  // If save() persistently fails (disk-full, quota), emitting an alert
  // on every retry would flood operators. Track a per-tokenId streak
  // and emit only at power-of-two boundaries (1, 2, 4, 8, …); reset
  // on save success. Per-token keying ensures distinct tokens have
  // independent counters. This Map is local to the builder — one
  // counter per `buildDefaultFinalizationWorkerRecipient` invocation,
  // matching the lifecycle of the `recipientFinalizationContext` Map.
  const saveFailureStreak = new Map<string, number>();
  const isPowerOfTwoBackoff = (n: number): boolean =>
    n > 0 && (n & (n - 1)) === 0;
  const dispositionWriter: FinalizationDispositionWriter = {
    async write(_addr, record) {
      if (record.disposition !== 'VALID') {
        return;
      }
      const tokenId = record.tokenId;
      const ctx = recipientFinalizationContext.get(tokenId);
      if (ctx === undefined) {
        logger.debug(
          'Payments',
          `Task #151: VALID disposition for ${tokenId.slice(0, 16)} but no finalization context`,
        );
        return;
      }
      try {
        const proof = await oracle.getProof(ctx.requestIdHex);
        if (proof === null || proof === undefined) {
          const msg = `Task #151: dispositionWriter VALID but oracle.getProof returned null for ${tokenId.slice(0, 16)} (requestId=${ctx.requestIdHex.slice(0, 16)})`;
          logger.warn('Payments', msg);
          // Wave 4 fix — surface to operators. proof-throw is the
          // closest existing DispositionReason for "we expected a proof
          // and the aggregator gave us nothing".
          emit('transfer:operator-alert', {
            code: 'proof-throw',
            tokenId: ctx.localTokenId,
            message: msg,
          });
          return;
        }
        const patchedLastTxJson = {
          ...ctx.lastTxJson,
          inclusionProof: proof.proof,
        };
        const stClient = getStateTransitionClient();
        const trustBase = getTrustBase();
        if (stClient === undefined || trustBase === null || trustBase === undefined) {
          logger.warn(
            'Payments',
            `Task #151: dispositionWriter VALID but stClient/trustBase missing for ${tokenId.slice(0, 16)} — falling back to status flip without re-finalization`,
          );
          const stored = tokens.get(ctx.localTokenId);
          if (stored !== undefined && stored.status === 'pending') {
            const updatedFallback: Token = {
              ...stored,
              status: 'confirmed',
              updatedAt: Date.now(),
            };
            tokens.set(ctx.localTokenId, updatedFallback);
            try {
              await save();
              // Wave 6 critical fix — only delete ctx after persistence
              // succeeds. The previous (Wave 2/4) ordering deleted
              // before save(), so a save() throw left ctx removed (no
              // retry possible) AND in-memory token flipped to
              // 'confirmed' while storage still showed 'pending'. On
              // reload the in-memory mutation is lost → token stuck
              // forever. Now mirrors the main success path below.
              recipientFinalizationContext.delete(tokenId);
              saveFailureStreak.delete(ctx.localTokenId);
              // Issue #195 (follow-up): emit `transfer:confirmed` so
              // listeners (notably AccountingModule) learn the inbound
              // deposit token is now aggregator-confirmed. Without this
              // emission an `invoice:covered` event never re-fires with
              // `confirmed: true`, leaving downstream consumers
              // (e.g. escrow swap orchestrator) stuck at PARTIAL_DEPOSIT
              // even after my CAS-mismatch fix unblocks the dispositionWriter.
              // Payload shape mirrors the NOSTR-FIRST and V5 emit sites.
              //
              // CAVEAT (steelman finding): `updatedFallback.sdkData` is in
              // SENDER-PREDICATE form — the recipient never ran
              // `finalizeTransferToken` on this path (it requires stClient
              // + trustBase, both missing here). The token is correctly
              // marked 'confirmed' for accounting purposes (the aggregator
              // anchored the commitment) but is NOT yet spendable: any
              // subsequent spend would build the commitment with the
              // sender's sourceState predicate while the authenticator
              // carries this wallet's pubkey, and `submitTransferCommitment`
              // would reject with "Authenticator does not match source
              // state predicate." The NOSTR-FIRST finalization path
              // (`handleCommitmentOnlyTransfer` → line ~13900) overwrites
              // `sdkData` with the properly finalized form once stClient
              // + trustBase become available. Listeners that read
              // `sdkData` for spend operations MUST guard against this
              // intermediate state.
              emit('transfer:confirmed', {
                id: crypto.randomUUID(),
                status: 'completed',
                tokens: [updatedFallback],
                tokenTransfers: [],
              });
            } catch (saveErr) {
              // Wave 6 critical fix — roll back the in-memory mutation
              // so retries can re-enter the `status === 'pending'`
              // guard above. Without this rollback, after the first
              // save() throw the in-memory token shows 'confirmed' and
              // the second retry skips the entire fallback block —
              // never re-attempting save() and never emitting an
              // alert. The retry path needs a clean 'pending' slate to
              // re-flip and retry persistence.
              //
              // Wave 7 steelman fix — compare-and-set rollback. While
              // we awaited save(), a concurrent path (another finalize,
              // a tombstone, a manual edit) may have replaced our
              // `updatedFallback` value with a different mutation. If
              // we blindly write `stored` back we clobber that work.
              // CAS: only restore if our update is still the current
              // value; otherwise leave the concurrent mutation alone.
              if (tokens.get(ctx.localTokenId) === updatedFallback) {
                tokens.set(ctx.localTokenId, stored);
              }
              const saveMsg = `Task #151: save() after status flip threw: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`;
              logger.warn('Payments', saveMsg);
              // Wave 4 fix — emit operator-alert when persistence fails.
              // Local Token state was mutated in-memory but didn't
              // round-trip to disk; operators need to know.
              // Wave 6 fix — power-of-two backoff so a permanent
              // disk-full failure doesn't flood operators with one
              // alert per retry. Streak keyed by tokenId so distinct
              // tokens accumulate independently.
              const prev = saveFailureStreak.get(ctx.localTokenId) ?? 0;
              const next = prev + 1;
              saveFailureStreak.set(ctx.localTokenId, next);
              if (isPowerOfTwoBackoff(next)) {
                emit('transfer:operator-alert', {
                  code: 'structural',
                  tokenId: ctx.localTokenId,
                  message: `${saveMsg} (consecutive save failures: ${next})`,
                });
              }
            }
          }
          return;
        }
        const lastTx = await TransferTransaction.fromJSON(patchedLastTxJson);
        const sourceToken = await SdkToken.fromJSON(ctx.sourceTokenJson);
        const finalizedToken = await finalizeTransferToken(
          sourceToken,
          lastTx,
          stClient,
          trustBase,
        );
        const stored = tokens.get(ctx.localTokenId);
        if (stored === undefined) {
          logger.debug(
            'Payments',
            `Task #151: local Token ${ctx.localTokenId.slice(0, 16)} disappeared before finalization`,
          );
          return;
        }
        const updated: Token = {
          ...stored,
          sdkData: JSON.stringify(finalizedToken.toJSON()),
          status: 'confirmed',
          updatedAt: Date.now(),
        };
        tokens.set(ctx.localTokenId, updated);
        try {
          await save();
          // Wave 5 fix — only delete ctx after persistence succeeds.
          // If save() threw, the in-memory mutation is lost on next
          // reload AND the ctx must be retained so an external retry
          // path (e.g. another disposition write or
          // payments.receive({finalize:true})) can re-attempt. This
          // matches the outer-catch retention promise below.
          recipientFinalizationContext.delete(tokenId);
          // Wave 6 fix — reset save-failure backoff on success.
          saveFailureStreak.delete(ctx.localTokenId);
          logger.debug(
            'Payments',
            `Task #151: token ${ctx.localTokenId.slice(0, 16)} finalized via recipient worker`,
          );
          // Issue #195 (follow-up): emit `transfer:confirmed` so
          // listeners (notably AccountingModule) learn the inbound
          // deposit token is now aggregator-confirmed. Without this
          // emission an `invoice:covered` event never re-fires with
          // `confirmed: true`, leaving downstream consumers (e.g. the
          // escrow swap orchestrator) stuck at PARTIAL_DEPOSIT even
          // after the CAS-mismatch fix unblocks the dispositionWriter.
          // Payload shape mirrors the NOSTR-FIRST and V5 emit sites.
          emit('transfer:confirmed', {
            id: crypto.randomUUID(),
            status: 'completed',
            tokens: [updated],
            tokenTransfers: [],
          });
        } catch (saveErr) {
          const saveMsg = `Task #151: save() after finalization threw: ${saveErr instanceof Error ? saveErr.message : String(saveErr)}`;
          logger.warn('Payments', saveMsg);
          // Wave 4 fix — emit operator-alert. The Token was finalized
          // and flipped to 'confirmed' in-memory, but persistence
          // failed; on the next reload the in-memory mutation is lost.
          // Wave 5 fix — ctx is intentionally NOT deleted here so a
          // retry path can pick it back up; consistent with the
          // outer-catch retention promise.
          // Wave 6 fix — power-of-two backoff so a permanent disk-full
          // failure doesn't flood operators. Streak keyed by tokenId.
          const prev = saveFailureStreak.get(ctx.localTokenId) ?? 0;
          const next = prev + 1;
          saveFailureStreak.set(ctx.localTokenId, next);
          if (isPowerOfTwoBackoff(next)) {
            emit('transfer:operator-alert', {
              code: 'structural',
              tokenId: ctx.localTokenId,
              message: `${saveMsg} (consecutive save failures: ${next})`,
            });
          }
        }
      } catch (err) {
        const errMsg = `Task #151: dispositionWriter finalization failed for ${tokenId.slice(0, 16)} — ${err instanceof Error ? err.message : String(err)}`;
        logger.warn(
          'Payments',
          errMsg,
          { err: err instanceof Error ? err.message : String(err) },
        );
        // Wave 4 fix — operator-alert on any unhandled finalization
        // error. Without this the local Token stays 'pending' forever
        // and the leak (`recipientFinalizationContext` entry retained
        // for retry) is invisible. We deliberately keep the ctx in
        // the Map so an external retry path (e.g. another disposition
        // write) can re-attempt.
        emit('transfer:operator-alert', {
          code: 'proof-throw',
          tokenId: ctx.localTokenId,
          message: errMsg,
        });
      }
    },
  };

  const worker = new FinalizationWorkerRecipient({
    addressId,
    queueStore: queue,
    queueAdapter,
    aggregator: aggregatorClient,
    resolver,
    pool,
    poolRead,
    manifestCas,
    tombstones,
    getPerTokenSemaphore,
    perTokenMutex,
    cascadeWalker,
    dispositionWriter,
    revaluateHooks,
    emit,
    now: () => Date.now(),
    sleep: (ms: number, abortSignal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        if (abortSignal?.aborted) {
          reject(new Error('aborted'));
          return;
        }
        const timer = setTimeout(resolve, ms);
        abortSignal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      }),
    ...(signal !== undefined ? { signal } : {}),
  });

  return {
    worker,
    queue,
    dispositionWriter,
    clearSaveFailureStreak: () => saveFailureStreak.clear(),
  };
}

// =============================================================================
// Round 5 (FIX 1) — default in-memory operator escape-hatch builders.
// =============================================================================

/**
 * Build a default {@link InclusionProofImporter} backed by in-memory
 * adapters. Auto-installed in `initialize()` when the bootstrap layer
 * has not already wired one. The defaults fail closed on every
 * operator-supplied proof (proof verification returns
 * `'NOT_AUTHENTICATED'`) so a misconfigured wallet cannot accidentally
 * apply unverified proofs — but the module no longer throws
 * `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED`, which lets operator scripts /
 * UIs probe the importer at startup without crashing.
 *
 * Production wiring should construct an OrbitDB-backed adapter (see
 * {@link OrbitDbDispositionStorageAdapter}) bound to the wallet's
 * ProfileDatabase plus a real `verifyProof` (the trust-base-aware
 * `verifyProof` from `transfer/proof-verifier.ts`), real
 * `graftCallback` / `overrideCallback` (the §5.5 step 5 4-step write
 * sequence + monotonicity-breach audit fields), and a real
 * `queueScanner` (the FinalizationQueue-backed scanner). Bootstrap
 * layers override via `payments.installInclusionProofImporter()`.
 *
 * @internal exposed for tests; production callers SHOULD NOT depend on
 *   this factory's exact shape — it is intentionally minimal.
 */
export function buildDefaultInclusionProofImporter(opts: {
  readonly emit: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void;
  /**
   * Round 7 (FIX 3) — Optional shared {@link PerTokenMutex} so the
   * operator importer serializes with the sender + recipient
   * finalization workers when they touch the same tokenId. Without
   * sharing, a concurrent `finalizeTransferToken(X)` and
   * `importInclusionProof(X)` race in their respective per-tokenId
   * guards (each builder previously created its own fresh mutex),
   * corrupting the manifest's audit trail or re-queuing duplicate K-1
   * entries. JSDoc on `ImportInclusionProofOptions.perTokenMutex` says
   * production callers SHOULD share — this knob fulfills that contract.
   */
  readonly perTokenMutex?: PerTokenMutex | null;
  /**
   * Round 7 (FIX 1) — Optional production-grade
   * `DispositionPerEntryStorage` adapter. When passed (e.g. an
   * {@link OrbitDbDispositionStorageAdapter} bound to the wallet's
   * ProfileDatabase), the importer's `_invalid` / `_audit` per-entry
   * records persist across restarts. When omitted, an
   * {@link InMemoryDispositionStorageAdapter} is used (the previous
   * default — preserves backward compatibility for tests + dev-mode
   * wallets without a profile stack).
   */
  readonly dispositionStorage?: import('../../profile/disposition-writer').DispositionPerEntryStorage;
  /**
   * Round 8 (FIX 1) — Optional production-grade
   * {@link ProofVerifier}. When passed (the Sphere bootstrap layer
   * builds an adapter over `oracle.verifyInclusionProof()`), the
   * importer's case 8 / 9 verification short-circuits run against the
   * trust-base-aware verifier so a real operator-supplied proof can
   * actually pass. When omitted, the default `'NOT_AUTHENTICATED'`
   * stub stays in place — the importer fails closed on every proof
   * (preserves the Round 7 default-safe semantics for callers without
   * a wired oracle).
   */
  readonly verifyProof?: import('./transfer/import-inclusion-proof').ProofVerifier;
  /**
   * Round 8 (FIX 1) — Optional production-grade graft callback. When
   * passed, case 3 (pending-graft) drives the §5.5 step 5 4-step write
   * sequence into the wallet's manifest store. When omitted, the
   * default no-op stub stays in place. The default harness's stub
   * `queueScanner` returns no entries, so this callback is unreachable
   * in the auto-installed default; bootstrap layers that wire a real
   * `queueScanner` (alongside this callback) close the production gap.
   */
  readonly graftCallback?: import('./transfer/import-inclusion-proof').ImportProofGraftCallback;
  /**
   * Round 8 (FIX 1) — Optional production-grade override callback.
   * When passed, cases 5 / 6 (operator override of `_invalid`) drive
   * the manifest stamp + audit-trail writes. When omitted, the default
   * no-op stub stays in place — same reachability caveat as
   * `graftCallback` above.
   */
  readonly overrideCallback?: import('./transfer/import-inclusion-proof').ImportProofOverrideCallback;
}): InclusionProofImporter {
  const { emit } = opts;

  // In-memory disposition storage — `_invalid` / `_audit` per-entry
  // records. Round 7 (FIX 1) — caller may pass an OrbitDb-backed
  // adapter for cross-restart persistence.
  const dispositionStorage = opts.dispositionStorage ?? new InMemoryDispositionStorageAdapter();

  // In-memory manifest storage — the operator escape-hatch reads
  // manifest entries to decide pending-vs-invalid routing.
  // Round 7 (FIX 5) — lowercase tokenId keys so mixed-case input from
  // operator scripts doesn't split the keyspace. The canonical-tokenId
  // regex contract says lowercase hex; storage keys must follow.
  const manifestEntries = new Map<string, TokenManifestEntry>();
  const manifestStorage: MinimalManifestStorage = {
    async readEntry(addr: string, tokenId: string) {
      return manifestEntries.get(`${addr}:${tokenId.toLowerCase()}`);
    },
    async writeEntry(addr: string, tokenId: string, entry: TokenManifestEntry) {
      manifestEntries.set(`${addr}:${tokenId.toLowerCase()}`, entry);
    },
  };
  const manifestStore = new ManifestStore({
    storage: manifestStorage,
    lamport: new Lamport(),
  });

  // Stub queue scanner — no live or hard-fail entries. Combined with
  // the stub verifyProof, every operator call resolves either to
  // `'no-such-token'` (no manifest entry) or `'tokenId-already-valid'` /
  // `'tokenId-in-invalid'` (depending on the manifest state, which is
  // also empty in the default harness).
  const queueScanner = {
    async lookupByTokenId() {
      return [];
    },
  };

  // Round 8 (FIX 1) — caller-supplied verifier wins. Default harness
  // fails closed (`NOT_AUTHENTICATED`) so the importer NEVER applies
  // an unverified proof; bootstrap layers that wire `oracle.
  // verifyInclusionProof()` swap in a real trust-base-aware verifier.
  const verifyProof = opts.verifyProof
    ?? (async (): Promise<ProofVerifyStatus> => 'NOT_AUTHENTICATED');

  // Round 8 (FIX 1) — caller-supplied graft callback wins. Default is
  // a no-op (case 3 unreachable in default harness because the stub
  // queueScanner returns no entries; the stub keeps the importer
  // structurally complete). When the bootstrap layer wires a real
  // queueScanner alongside this callback, case 3 becomes reachable.
  const graftCallback = opts.graftCallback ?? {
    async graft() {
      /* no-op */
    },
  };

  // Round 8 (FIX 1) — caller-supplied override callback wins. Default
  // is a no-op for the same reachability reason as `graftCallback`.
  const overrideCallback = opts.overrideCallback ?? {
    async applyOverride() {
      /* no-op */
    },
  };

  return new InclusionProofImporter({
    manifestStore,
    dispositionStorage,
    queueScanner,
    verifyProof,
    graftCallback,
    overrideCallback,
    emit,
    // Round 7 (FIX 3) — when caller provides a shared mutex, plumb it
    // through so this importer instance serializes against the
    // PaymentsModule's finalization workers. Default (undefined) leaves
    // the importer's own internal fallback in place.
    ...(opts.perTokenMutex !== null && opts.perTokenMutex !== undefined
      ? { perTokenMutex: opts.perTokenMutex }
      : {}),
  });
}

/**
 * Build a default {@link RevalidateCascadedRunner} backed by an
 * in-memory manifest scanner. Auto-installed in `initialize()` when
 * the bootstrap layer has not already wired one. The default scanner
 * surfaces no children for any parent, so `revalidateCascadedChildren`
 * resolves with `{ checked: 0, revalidated: 0, ... }` — equivalent to
 * "the operator's parent had no cascaded children", which is the
 * correct verdict for a freshly-bootstrapped wallet that hasn't yet
 * ingested any transfers.
 *
 * Production override (via `payments.installRevalidateCascadedRunner()`)
 * wires a manifestScanner that reads the wallet's OrbitDB-backed
 * manifest collection and a `revalidateChild` validator that runs the
 * §5.3 [B]/[C]/[E] sub-checks against the child token.
 *
 * @internal exposed for tests; production callers SHOULD NOT depend on
 *   this factory's exact shape — it is intentionally minimal.
 */
export function buildDefaultRevalidateCascadedRunner(): RevalidateCascadedRunner {
  // Empty in-memory scanner — no children for any parent. The
  // manifestStore returns undefined for every readEntry, so the
  // pre-loop parent-validity check classifies every cascaded subtree
  // as "still invalid". The runner returns zero counts.
  // Round 7 (FIX 5) — lowercase tokenId keys to match the canonical-
  // tokenId regex contract; mixed-case input must not split the
  // keyspace.
  const manifestEntries = new Map<string, TokenManifestEntry>();
  const manifestScanner: CascadeManifestScannerForRevalidate = {
    async readEntry(addr: string, tokenId: string) {
      return manifestEntries.get(`${addr}:${tokenId.toLowerCase()}`);
    },
    async findChildren() {
      return [];
    },
  };
  const manifestStorage: MinimalManifestStorage = {
    async readEntry(addr: string, tokenId: string) {
      return manifestEntries.get(`${addr}:${tokenId.toLowerCase()}`);
    },
    async writeEntry(addr: string, tokenId: string, entry: TokenManifestEntry) {
      manifestEntries.set(`${addr}:${tokenId.toLowerCase()}`, entry);
    },
  };
  const manifestStore = new ManifestStore({
    storage: manifestStorage,
    lamport: new Lamport(),
  });

  // Stub revalidator — never fires because findChildren always returns
  // []. Including it keeps the runner structurally complete.
  const revalidateChild = async () =>
    ({ kind: 'parent-still-invalid' } as const);

  return new RevalidateCascadedRunner({
    manifestScanner,
    manifestStore,
    revalidateChild,
  });
}

// =============================================================================
// Factory Function
// =============================================================================

export function createPaymentsModule(config?: PaymentsModuleConfig): PaymentsModule {
  return new PaymentsModule(config);
}
