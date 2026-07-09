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
import type { SplitPlan, TokenWithAmount } from './TokenSplitCalculator';
import type { ITokenEngine, MintJustificationVerifierService, SphereToken, TokenBlob } from '../../token-engine';
import { TransferConflictError } from '../../token-engine';
import { WalletApiError } from '../../wallet-api';
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
import type { DeliveryProvider, IncomingDelivery, WakeStream } from '../../transport/delivery-provider';
import { TransportDeliveryAdapter } from './TransportDeliveryAdapter';
import { deriveFieldEncryptionKey, encryptField, decryptField } from '../../core/field-encryption';
import {
  deriveDeliveryEncryptionKey,
  encryptDeliveryBundle,
  decryptDeliveryBundle,
} from '../../core/delivery-envelope';
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
import { sleep } from '../../core/utils';
import { timeoutSignal } from '../../core/timeout';
import { randomUUID } from '../../core/uuid';
import { decodeTokenBlob, encodeTokenBlob, unwrapTokenBlobBytes, TOKEN_BLOB_VERSION } from '../../token-engine/token-blob';
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
  return `${type}_${randomUUID()}`;
}

/** Maximum number of history entries to include in IPFS-synced TXF data */
const MAX_SYNCED_HISTORY_ENTRIES = 5000;

/**
 * Cap on the number of newest-first keyset pages pulled when rebuilding history
 * from the server on reload (the wallet-api composition). At the §16 page limit
 * this bounds a single hydration well past any realistic wallet's recent
 * history while staying finite if the server ever mis-reports `more`.
 */
const MAX_HISTORY_HYDRATION_PAGES = 100;

/**
 * Cap on the number of gap-free `?since=` pages pulled when rebuilding the
 * incoming payment-request view from the server on reload (the wallet-api
 * composition — the #556 reload fix). At the §16 page limit this bounds a
 * single hydration past any realistic payer's request history while staying
 * finite if the server ever mis-reports `more`. Mirrors
 * {@link MAX_HISTORY_HYDRATION_PAGES}.
 */
const MAX_PR_HYDRATION_PAGES = 100;

/**
 * Overall timeout for a single engine transfer/split during send(). Overrides
 * the SDK's 10s default inclusion-proof abort — a slow aggregator must get a
 * fair window, because once the certification is submitted the source state is
 * spent on-chain and an early abort strands the finished token.
 */
const SEND_ENGINE_OP_TIMEOUT_MS = 60_000;

/**
 * Incoming-delivery poll interval (sdk-changes S3). The pull is the
 * correctness path; the optional wake hook only shortens latency (§9 — a
 * dropped wake can never cause divergence).
 */
const DELIVERY_POLL_INTERVAL_MS = 30_000;

/**
 * Bounded replay budget for journaled finished-but-undelivered v2 blobs (#517
 * item 1). Each load()'s replay pass makes at most {@link DELIVERY_REPLAY_RETRIES}
 * + 1 attempts per entry with exponential backoff; the cumulative failed-attempt
 * count is journaled across loads. Once it reaches
 * {@link MAX_DELIVERY_REPLAY_ATTEMPTS} (inclusive) the entry is surfaced as poison
 * (`delivery:undeliverable`) and left journaled but no longer auto-retried —
 * the deposit is idempotent, so a later app version may still land it.
 */
const DELIVERY_REPLAY_RETRIES = 2;
const MAX_DELIVERY_REPLAY_ATTEMPTS = 6;
/** #623: incoming claim/reject are submitted in batches of this size (one request each) so a large
 * inbox drain doesn't fire one write per entry and trip the per-owner rate limit. */
const INCOMING_ACK_BATCH_SIZE = 200;
/** #625: max times send() re-plans after demoting an already-spent source (self-healing selection).
 * A backstop — each retry permanently demotes one stale source, so convergence is fast. */
const MAX_RESELECT_ATTEMPTS = 8;
/** §3.1 (#621): how long a recipient-quota (429) delivery is deferred before the next replay attempt. */
const DELIVERY_DEFERRAL_MS = 60 * 60 * 1000; // 1h
const DELIVERY_REPLAY_BASE_DELAY_MS = 1_000;
const DELIVERY_REPLAY_MAX_DELAY_MS = 8_000;

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
   * Cumulative failed replay attempts across load()s. Surfaced as poison and
   * marked `undeliverable` once it reaches {@link MAX_DELIVERY_REPLAY_ATTEMPTS}
   * so journaled blobs never sit undelivered invisibly (#517).
   */
  attempts?: number;
  /** Set once the entry is surfaced as poison; it stays journaled but is no longer auto-retried. */
  undeliverable?: boolean;
  /**
   * (transferId, opIndex) pairing (§8.1) — the op's position in the intent's persisted order.
   * Lets resume RE-DELIVER this already-certified blob instead of re-running the engine op
   * (which would raise TransferConflictError on the spent source). Absent on legacy entries.
   */
  opIndex?: number;
  /**
   * §3.1 (#621): a recipient-side 429 (full mailbox / never-claimer) is NOT poison — it self-heals
   * when the recipient drains. Such entries are deferred (kept journaled, never auto-poisoned) and
   * retried no sooner than this epoch-ms; the count does not consume the case-A poison budget.
   */
  deferredUntil?: number;
  /** Why the entry is deferred (observability) — e.g. 'recipient-quota'. */
  deferredReason?: string;
}

/** Running per-coin totals folded by {@link PaymentsModule.aggregateTokens}. */
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
    coinId: 'UNKNOWN',
    symbol: 'UNKNOWN',
    name: 'Unknown Token',
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
// LOCAL-namespace keys ONLY (journal/tombstone dedup): this stateHash is a
// plain sha256 over the token bytes — it is NOT the protocol state hash the
// backend uses (that is token-engine deriveDeliveryKeys / the SDK imprint).
// Both writers and readers of these keys use THIS function; never mix the two
// derivations in one comparison.
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
// wallet-api port (sdk-changes E.3/S2/S4 — the slice PaymentsModule consumes)
// =============================================================================

/** §16 payment-request wire record (structural mirror of `wallet-api/types.ts`). */
export interface WalletApiPaymentRequest {
  id: string;
  /** Per-payer gap-free, commit-ordered seq (§9/§10) — the incoming cursor unit. */
  seq: bigint;
  fromPubkey: string;
  toPubkey: string;
  assets: { coinId: string; amount: bigint }[];
  /** S6 `enc1.` envelope, verbatim — decrypts only under the requester's wallet key. */
  memo?: string;
  status: 'open' | 'paid' | 'declined' | 'expired';
  transferId: string | null;
  createdAt: number;
  expiresAt?: number;
}

/** §16 list query — the two role views carry DIFFERENT cursor families (never mixed). */
export type WalletApiListPaymentRequestsParams =
  | { role: 'incoming'; status?: 'open' | 'paid' | 'declined' | 'expired'; since?: bigint }
  | { role: 'outgoing'; status?: 'open' | 'paid' | 'declined' | 'expired'; before?: string };

/** §16 list page, discriminated by the requested role. */
export type WalletApiPaymentRequestsPage =
  | {
      role: 'incoming';
      requests: WalletApiPaymentRequest[];
      more: boolean;
      /** The gap-free `?since=` seq cursor (§9/§16). */
      cursor: bigint;
      syncEpoch: bigint;
    }
  | {
      role: 'outgoing';
      requests: WalletApiPaymentRequest[];
      more: boolean;
      /** Opaque keyset for the next (older) page; null when drained (§16). */
      cursor: string | null;
      syncEpoch: bigint;
    };

/**
 * One §16 history wire record (§10 — the server never writes history rows).
 * `memo` / `counterpartyNametag` are S6 `enc1.` envelopes, verbatim (§8.3) —
 * encrypted on POST, returned encrypted on GET, decrypted by the owner only.
 */
export interface WalletApiHistoryRecord {
  dedupKey: string;
  id: string;
  type: string;
  ts: string;
  assets: { coinId: string; amount: string }[];
  transferId?: string;
  tokenId?: string;
  counterpartyPubkey?: string;
  memo?: string;
  counterpartyNametag?: string;
}

/**
 * The narrow, STRUCTURAL slice of the wallet-api client this module needs:
 * the E.3 intent lifecycle, blob uploads for spend outputs, and the §10
 * client-written history log. `WalletApiClient` satisfies it as-is; the
 * module never imports the client (covenant §3.1-6 — no provider-specific
 * logic outside implementations; the spec itself makes these endpoints the
 * module's responsibility: sdk-changes E.3 + S2 consumer update).
 */
export interface PaymentsWalletApiPort {
  /** E.3: persist the client-encrypted intent; MUST be awaited before the engine. */
  putIntent(transferId: string, payloadEnvelope: string): Promise<void>;
  /** E.3 uniform close — every finished send ends with this (idempotent). */
  completeIntent(transferId: string): Promise<void>;
  /** E.2 lost-race cleanup (soft, recoverable). */
  abortIntent(transferId: string): Promise<void>;
  /** E.3 resume: list open intents at sign-in (any device). */
  listIntents(status: 'open' | 'aborted'): Promise<
    { transferId: string; payload: string; status: 'open' | 'completed' | 'aborted'; createdAt: number }[]
  >;
  /** §5.2 checksum-bound presigned PUTs for spend outputs. */
  getUploadUrls(
    blobs: { sha256: string; size: number }[]
  ): Promise<{ sha256: string; key: string; putUrl: string }[]>;
  /** Upload to a presigned PUT (a 412 = already present = success — §5.2). */
  uploadBlob(putUrl: string, bytes: Uint8Array): Promise<void>;
  /** §10: client-asserted history records (§16 wire shape), deduped by dedupKey server-side. */
  postHistoryRecords(records: WalletApiHistoryRecord[]): Promise<void>;
  /**
   * §10/§16: read the client-written history log back — newest-first keyset
   * pages (`{records, more, cursor, syncEpoch}`). The READ side of the §10 log:
   * a reloaded thin wallet rebuilds its history from here (the in-memory cache
   * is process-lifetime; the durable log lives on the server). `memo` /
   * `counterpartyNametag` come back as the verbatim S6 `enc1.` envelopes — the
   * owner decrypts them with its own field key on display (§8.3).
   */
  listHistory(options?: { before?: string; limit?: number }): Promise<{
    records: WalletApiHistoryRecord[];
    more: boolean;
    cursor: string | null;
    syncEpoch: bigint;
  }>;

  // ── payment requests (sdk-changes S4 — §10/§16) — OPTIONAL capability ───────
  // When the composed port carries all three endpoints (the S4 wallet-api
  // presets do — `WalletApiClient` provides them), payment requests ride
  // wallet-api and the Nostr payment-request channel is NOT installed.
  // Compositions without them keep the transport path (port selection,
  // covenant §3.1-6). Pre-S4 mocks/ports stay structurally conformant.

  /** Network name — scopes the persisted payment-request cursor (mirrors the mailbox cursor). */
  readonly network?: string;
  /** `POST /v1/payment-requests` (§16) — `memo` MUST already be an S6 envelope (§8.3). */
  createPaymentRequest?(input: {
    toPubkey: string;
    assets: { coinId: string; amount: bigint }[];
    memo?: string;
    expiresAt?: number;
  }): Promise<WalletApiPaymentRequest>;
  /** `GET /v1/payment-requests?role=` (§16) — role-bound cursor families. */
  listPaymentRequests?<R extends 'incoming' | 'outgoing'>(
    params: Extract<WalletApiListPaymentRequestsParams, { role: R }>
  ): Promise<Extract<WalletApiPaymentRequestsPage, { role: R }>>;
  /** `POST /v1/payment-requests/{id}/respond` (§16) — paid links the fulfilling transferId. */
  respondPaymentRequest?(
    id: string,
    response: { action: 'paid'; transferId: string } | { action: 'declined' }
  ): Promise<WalletApiPaymentRequest>;
}

/**
 * The S4 capability slice once detected (see
 * {@link PaymentsModule.paymentRequestsApi}) — the optional members above,
 * required.
 */
type PaymentRequestsApi = Pick<PaymentsWalletApiPort, 'network'> &
  Required<
    Pick<PaymentsWalletApiPort, 'createPaymentRequest' | 'listPaymentRequests' | 'respondPaymentRequest'>
  >;

/** The decrypted E.3 intent payload (`{ sources, recipient, amounts }` concretized). */
interface IntentPayloadV1 {
  v: 1;
  /** Recipient chain pubkey (33-byte compressed, hex). */
  recipient: string;
  coinId: string;
  /** Requested amount (decimal string). */
  amount: string;
  memo?: string;
  invoiceRefundAddress?: string;
  invoiceContact?: { address: string; url?: string };
  /** Genesis token ids transferred whole, in execution order. */
  direct: string[];
  /** The at-most-one split (ARCHITECTURE §7). */
  split?: { tokenId: string; splitAmount: string; remainderAmount: string };
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
  /**
   * Token engine (v2). Optional during migration (path B): when provided, value
   * reads / lifecycle go through the engine; otherwise the legacy v1 SDK path is
   * used. Wired by Sphere once the engine is constructed (A4-int).
   */
  tokenEngine?: ITokenEngine;
  emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
  /** Price provider (optional — enables fiat value display) */
  price?: PriceProvider;
  /** Set of disabled provider IDs — disabled providers are skipped during sync/save */
  disabledProviderIds?: ReadonlySet<string>;
  /**
   * Delivery port (sdk-changes S7). When provided, ASSET transfers ride it
   * exclusively — outgoing via `deliver()`, incoming via `incoming()` (poll +
   * wake) — and the transport's token-transfer subscription is NOT installed
   * (S4: assets leave Nostr; DMs/group-chat/nametags stay). When absent, a
   * {@link TransportDeliveryAdapter} preserves the legacy relay path through
   * the same seam.
   */
  delivery?: DeliveryProvider;
  /**
   * wallet-api slice for the E.3 intent lifecycle, output uploads and §10
   * history (see {@link PaymentsWalletApiPort}). Present in wallet-api
   * compositions (full preset AND own-storage preset); absent in fully-local
   * ones.
   */
  walletApi?: PaymentsWalletApiPort;
  /** Current address's canonical display nametag (bare, no '@'), from the Sphere-level Nostr-backed store. Preferred over the local minted-token nametags[] for outgoing memos. */
  getCurrentNametag?: () => string | undefined;
}

/** The provider {@link PaymentsModule.getActiveTokenStorageProvider} will pick:
 * first non-disabled entry, mirroring getTokenStorageProviders' precedence. */
function firstEnabledTokenStorage(
  deps: PaymentsModuleDependencies
): TokenStorageProvider<TxfStorageDataBase> | null {
  const providers =
    deps.tokenStorageProviders && deps.tokenStorageProviders.size > 0
      ? [...deps.tokenStorageProviders.entries()]
      : deps.tokenStorage
        ? [[deps.tokenStorage.id, deps.tokenStorage] as const]
        : [];
  for (const [id, provider] of providers) {
    if (!deps.disabledProviderIds?.has(id)) return provider;
  }
  return null;
}

/**
 * Fail-closed composition invariant (#515 F1, sdk-changes S7): wallet-api
 * CUSTODY artifacts — delivery custody `'inventory'` (acks write the server
 * inventory) or an active token-storage provider that declares
 * `requiresWalletApi` (the S2 thin provider) — are only legal WITH the
 * wallet-api client. The E.3 intent barrier and §7 server apply are
 * guard-by-presence on `deps.walletApi`, so an accidentally-degraded
 * composition (e.g. a stale bundle dropping the client) would silently run
 * local-custody semantics while the user believes wallet-api custody is
 * active. Legal compositions (the composition.ts presets):
 *  - fully local: no wallet-api artifacts, no client;
 *  - FULL preset: thin storage + custody 'inventory' + client;
 *  - OWN-STORAGE preset: own storage + custody 'external' + client.
 * Own storage + custody 'external' WITHOUT a client stays legal (no custody
 * artifact — delivery fails loudly at call time, nothing is silently lost).
 */
function assertLegalCustodyComposition(deps: PaymentsModuleDependencies): void {
  if (deps.walletApi) return;
  if (deps.delivery?.custody === 'inventory') {
    throw new SphereError(
      "Illegal composition (#515): delivery custody is 'inventory' (wallet-api server custody) but no `walletApi` client was provided — refusing to initialize. " +
        "Pass the preset's `walletApi` to Sphere.init, or compose the own-storage preset (custody 'external').",
      'INVALID_CONFIG'
    );
  }
  const storage = firstEnabledTokenStorage(deps);
  if (storage?.requiresWalletApi) {
    throw new SphereError(
      `Illegal composition (#515): the active token-storage provider '${storage.id}' keeps custody in the wallet-api backend but no \`walletApi\` client was provided — refusing to initialize. ` +
        "Pass the preset's `walletApi` to Sphere.init, or compose a local storage provider.",
      'INVALID_CONFIG'
    );
  }
}

// =============================================================================
// Implementation
// =============================================================================

export class PaymentsModule {
  private readonly moduleConfig: Required<PaymentsModuleConfig>;
  private deps: PaymentsModuleDependencies | null = null;

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

  // Delivery port (sdk-changes S3/S7)
  /** The single delivery seam — an injected provider or the transport adapter. */
  private delivery: DeliveryProvider | null = null;
  /** Set only when a provider was INJECTED — gates the incoming pump (S3). */
  private injectedDelivery: DeliveryProvider | null = null;
  private deliveryWakeUnsub: (() => void) | null = null;
  private deliveryPollTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Low-frequency inventory poll (§9): the correctness backstop that converges
   * the owned-token set even when an `inventory` wake is missed. Mirrors the
   * delivery/PR pumps' interval; the wake is just a nudge that pulls sooner.
   */
  private inventoryPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Coalesces concurrent incoming-pump runs. */
  private pumpInFlight: Promise<number> | null = null;
  /** S6 field-encryption key (intent payloads, history memos) — per identity. */
  private fieldEncryptionKey: Uint8Array | null = null;

  // wallet-api payment requests (sdk-changes S4 — §10/§16)
  private prPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Coalesces concurrent payment-request pump runs. */
  private prPumpInFlight: Promise<void> | null = null;
  /**
   * Set after the once-per-session full incoming hydration (#556): the surfaced
   * incoming list is in-memory only, so on a fresh engine the CURRENT state of
   * ALL incoming requests — open AND resolved (paid/declined/expired) — must be
   * rebuilt from a `role=incoming&since=0` pull, not just the still-open ones.
   * A status-filtered bootstrap (the pre-#556 `status=open` scan) dropped
   * requests resolved in a PRIOR session, so the payer reopened and the
   * 'Paid Successfully' request was gone (twin of #521/#549).
   */
  private prBootstrapped = false;

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
  /**
   * Base delay (ms) for the journaled-delivery replay backoff (#517 item 1).
   * A field, not a const, so tests can drive the bounded retry loop without
   * waiting real time — never mutated in production.
   */
  private replayBackoffBaseMs = DELIVERY_REPLAY_BASE_DELAY_MS;
  /** Deferral window for recipient-quota (429) deliveries (#621). Overridable in tests. */
  private deliveryDeferralMs = DELIVERY_DEFERRAL_MS;
  /**
   * #517: serializes {@link replayPendingV2Deliveries}. `load()` kicks replay
   * off fire-and-forget and `receive()` calls `load()`, so two passes can
   * overlap — duplicating delivery attempts and clobbering each other's
   * `attempts` increments (both read the same stale value, both write N+1,
   * delaying poison surfacing). Only one pass runs per module instance at a time.
   */
  private replayInFlight = false;
  /**
   * #517: serializes every read-modify-write of the PENDING_V2_DELIVERIES journal.
   * save/remove/update each load → mutate → store the WHOLE blob, so a replay
   * (fire-and-forget from load()) overlapping a send()'s journal write could
   * clobber a newly-saved undelivered entry and lose it — defeating the crash-
   * safety guarantee. A promise-chain mutex makes each whole RMW atomic.
   */
  private journalMutation: Promise<unknown> = Promise.resolve();

  constructor(config?: PaymentsModuleConfig) {
    this.moduleConfig = {
      autoSync: config?.autoSync ?? true,
      autoValidate: config?.autoValidate ?? true,
      retryFailed: config?.retryFailed ?? true,
      maxRetries: config?.maxRetries ?? 3,
      debug: config?.debug ?? false,
    };

    // Initialize spend queue (requires ledger, planner, and access to this.tokens)
    this.spendQueue = new SpendQueue(
      this.reservationLedger,
      this.spendPlanner,
      () => this.tokens,
      this.parsedTokenCache
    );
  }

  /**
   * Get the current module configuration.
   *
   * @returns Resolved configuration with all defaults applied.
   */
  getConfig(): Required<PaymentsModuleConfig> {
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
    // #515 F1: refuse illegal custody compositions BEFORE any state is touched.
    assertLegalCustodyComposition(deps);

    // Clean up previous subscriptions before re-initializing
    this.unsubscribeTransfers?.();
    this.unsubscribeTransfers = null;
    this.unsubscribePaymentRequests?.();
    this.unsubscribePaymentRequests = null;
    this.unsubscribePaymentRequestResponses?.();
    this.unsubscribePaymentRequestResponses = null;
    this.teardownDeliveryPump();
    this.teardownPaymentRequestPump();

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
    this.fieldEncryptionKey = null; // re-derived lazily per identity (S6)
    // Path B: wire the engine into the planner (value reads use it when present).
    this.spendPlanner.setEngine(deps.tokenEngine);

    // Delivery seam (sdk-changes S3/S7): the injected port, or the transport
    // adapter preserving the legacy relay leg through the same seam.
    this.injectedDelivery = deps.delivery ?? null;
    const lazyDeliveryKeys = async (blobBytes: Uint8Array): Promise<{ tokenId: string; stateHash: string }> => {
      const engine = this.deps?.tokenEngine;
      if (!engine) throw new SphereError('Token engine required for delivery-key derivation (S7)', 'AGGREGATOR_ERROR');
      return engine.deliveryKeys(blobBytes);
    };
    this.delivery = deps.delivery ?? new TransportDeliveryAdapter(deps.transport, lazyDeliveryKeys);
    // S7: the module owns the engine — late-bind the backend-true derivation
    // into whatever delivery provider was composed.
    this.delivery.bindDeliveryKeys?.(lazyDeliveryKeys);
    this.delivery.setIdentity?.({
      privateKey: deps.identity.privateKey,
      chainPubkey: deps.identity.chainPubkey,
    });

    // Incoming assets (sdk-changes S3/S4): with an injected delivery port the
    // mailbox pull (poll + wake) is the ONLY asset channel — the Nostr
    // token-transfer subscription is not installed. Without one, the relay
    // push subscription stays exactly as before.
    if (this.injectedDelivery) {
      // One wake socket multiplexes all three owner streams (§9): route each
      // nudge to its own (debounced/coalesced) pull. The wake is best-effort —
      // every stream below also has a poll backstop that is the correctness
      // path. (Before this, only `mailbox` was consumed, so a second session
      // saw no realtime inventory/payment-request convergence.)
      this.deliveryWakeUnsub =
        this.injectedDelivery.onWake?.(
          (stream) => this.handleWake(stream),
          // §9: surface TRUE wake-socket liveness, decoupled from sign-in state,
          // so the frontend can show a "live/reconnecting" indicator.
          (status) => this.deps?.emitEvent('realtime:status', { status })
        ) ?? null;
      // Poll is the correctness path; the wake is just a nudge (§9).
      this.deliveryPollTimer = setInterval(() => {
        void this.pumpIncomingDeliveries().catch((err) =>
          logger.warn('Payments', 'Incoming delivery pump (poll) failed:', err)
        );
      }, DELIVERY_POLL_INTERVAL_MS);
      // Inventory poll backstop (§9): converges the owned-token set even if an
      // `inventory` wake is missed, mirroring the delivery/PR pumps' interval.
      this.inventoryPollTimer = setInterval(() => {
        void this.resyncInventory().catch((err) =>
          logger.warn('Payments', 'Inventory resync (poll) failed:', err)
        );
      }, DELIVERY_POLL_INTERVAL_MS);
    } else {
      // Subscribe to incoming transfers
      this.unsubscribeTransfers = deps.transport.onTokenTransfer((transfer) =>
        this.handleIncomingTransfer(transfer)
      );
    }

    // Payment requests (sdk-changes S4): when the composed wallet-api port
    // carries the §16 payment-request endpoints they ride wallet-api — the
    // incoming `?since=<seq>` stream is polled (gap-free — §9; the poll is the
    // correctness path) and the Nostr payment-request channel is NOT
    // installed. Without the capability the transport subscriptions stay
    // exactly as before (port selection, covenant §3.1-6).
    this.prBootstrapped = false;
    if (this.paymentRequestsApi()) {
      this.prPollTimer = setInterval(() => {
        void this.pumpPaymentRequests().catch((err) =>
          logger.warn('Payments', 'Payment-request pump (poll) failed:', err)
        );
      }, DELIVERY_POLL_INTERVAL_MS);
    } else {
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
      let loadedProvider: TokenStorageProvider<TxfStorageDataBase> | null = null;
      for (const [id, provider] of providers) {
        try {
          const result = await provider.load();
          if (result.success && result.data) {
            // Address guard: reject data persisted under a different address.
            // _meta.address holds chainPubkey for current writes; legacy records
            // hold an alpha1 value (pre-L1-removal) and are tolerated — the token
            // store is partitioned by chainPubkey, and the record is rewritten to
            // chainPubkey on the next save.
            const loadedMeta = (result.data as TxfStorageDataBase)?._meta;
            const currentChain = this.deps!.identity.chainPubkey;
            const isLegacyAlpha = loadedMeta?.address?.startsWith('alpha1') ?? false;
            if (loadedMeta?.address && currentChain && !isLegacyAlpha && loadedMeta.address !== currentChain) {
              logger.warn('Payments', `Load: rejecting data from provider ${id} — address mismatch (got=${loadedMeta.address.slice(0, 20)}... expected=${currentChain.slice(0, 20)}...)`);
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
            loadedProvider = provider;
            break; // Use first successful provider
          }
        } catch (err) {
          logger.error('Payments', `Failed to load from provider ${id}:`, err);
        }
      }

      // S2: merge the provider's inventory VIEW as lazy records — value
      // metadata only, ZERO blob downloads. A thin provider (wallet-api)
      // contributes the wallet's whole balance this way (coin-selection plans
      // from it; getToken() materializes only the selected sources); for
      // whole-blob providers the view equals the loaded set and nothing is
      // added. Guarded structurally: pre-S2 custom providers (and test mocks)
      // built before the port extension may lack `listInventory` — they keep
      // working through the whole-blob path, just without a lazy view.
      if (loadedProvider && typeof loadedProvider.listInventory === 'function') {
        try {
          await this.mergeLazyInventory(loadedProvider);
        } catch (err) {
          logger.warn('Payments', 'load(): inventory view merge failed:', err);
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

    // S3: drain the delivery port's incoming feed once at load (poll + wake
    // keep it drained afterwards).
    if (this.injectedDelivery) {
      void this.pumpIncomingDeliveries().catch((err) =>
        logger.warn('Payments', 'Incoming delivery pump (load) failed:', err));
    }

    // S4: drain the payment-request `?since=` stream once at load (the poll
    // keeps it drained afterwards).
    if (this.paymentRequestsApi()) {
      void this.pumpPaymentRequests().catch((err) =>
        logger.warn('Payments', 'Payment-request pump (load) failed:', err));
    }
  }

  /**
   * Cleanup all subscriptions, polling jobs, and pending resolvers.
   *
   * Should be called when the wallet is being shut down or the module is
   * no longer needed.
   */
  destroy(): void {
    this.unsubscribeTransfers?.();
    this.unsubscribeTransfers = null;
    this.unsubscribePaymentRequests?.();
    this.unsubscribePaymentRequests = null;
    this.unsubscribePaymentRequestResponses?.();
    this.unsubscribePaymentRequestResponses = null;
    this.teardownDeliveryPump();
    this.teardownPaymentRequestPump();
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
  /**
   * #625 — self-healing coin selection. If a selected source turns out already spent on-chain
   * (`TransferConflictError`), demote it (durable `suspectedSpent` — kept in inventory, excluded from
   * selection) and re-plan with the next candidate, bounded. A fixed plan (`instantSplitSend`) is not
   * re-planned. Exhausting the live candidates surfaces a clean `SEND_INSUFFICIENT_BALANCE` (or the
   * final conflict), never an endless loop.
   */
  async send(
    request: TransferRequest,
    internal?: { existingReservationId?: string; existingSplitPlan?: SplitPlan },
  ): Promise<TransferResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.sendOnce(request, internal);
      } catch (err) {
        const conflictedId = err instanceof TransferConflictError ? err.conflictedSourceId : undefined;
        if (
          conflictedId !== undefined &&
          attempt < MAX_RESELECT_ATTEMPTS &&
          internal?.existingSplitPlan === undefined &&
          this.tokens.has(conflictedId)
        ) {
          await this.demoteSuspectedSpent(conflictedId);
          logger.warn(
            'Payments',
            `Source ${conflictedId} already spent on-chain — demoted, re-planning with the next candidate (#625, attempt ${attempt + 1}/${MAX_RESELECT_ATTEMPTS})`,
          );
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * #625: mark a source token suspected-spent (a `TransferConflictError` proved its state consumed
   * on-chain). It stays in inventory (visible, recoverable by a resync — never auto-removed) but is
   * excluded from spend selection (SpendQueue) so coin-selection picks live tokens instead.
   */
  private async demoteSuspectedSpent(tokenId: string): Promise<void> {
    const token = this.tokens.get(tokenId);
    if (!token) return;
    token.suspectedSpent = true;
    this.tokens.set(tokenId, token);
    try {
      await this.save();
    } catch (err) {
      logger.warn('Payments', `Failed to persist suspectedSpent for ${tokenId} (re-derived on the next conflict):`, err);
    }
  }

  private async sendOnce(
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
      id: internal?.existingReservationId ?? randomUUID(),
      status: 'pending',
      tokens: [],
      tokenTransfers: [],
    };

    // W23-R2 (v2): ids of source tokens whose spend was CERTIFIED on-chain during
    // this send. The failure handler must never restore these as 'confirmed' —
    // their state is consumed; the finished output blob is journaled separately.
    const committedOnChainTokenIds = new Set<string>();
    // §3.1 (#621): set when any leg's post-certification delivery is deferred (kept journaled).
    // Scoped to the whole send so the resolve path below can mark the result delivery-pending.
    let deliveryPending = false;

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

      // Mark as transferring and persist — UI shows "Pending" badge immediately.
      // critical (#515 F2): nothing is spent yet — an unwritable active custody
      // provider must abort the send HERE, before the intent/engine run.
      for (const token of tokensToSend) {
        token.status = 'transferring';
        this.tokens.set(token.id, token);
        this.parsedTokenCache.delete(token.id);
      }
      await this.save({ critical: true });

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
        const walletApi = this.deps.walletApi;
        const delivery = this.delivery!;
        // §7/§5.3: with wallet-api INVENTORY custody the spend is recorded
        // server-side via ONE applyDelta carrying this send's transferId —
        // the evidence link to the mailbox deposit. With 'external' custody
        // (the own-storage composition) the sender never calls apply
        // (ARCHITECTURE §6: storage-opt-out senders); local bookkeeping is
        // the record and the intent closes via completeIntent alone.
        const serverApply = !!walletApi && delivery.custody === 'inventory';
        const recipientChainPubkeyHex = peerInfo.chainPubkey;
        const recipientChainPubkey = hexToBytes(recipientChainPubkeyHex);
        // On-chain memo: the structured invoice ref ({inv:{id,dir}}) for invoice
        // payments, else null — plain memos stay transport-only (privacy).
        // parseInvoiceMemoForOnChain already produced the encoded bytes (or null).
        const memoData = onChainMessage ?? undefined;

        // S2: blobs are fetched on demand — lazy inventory records selected by
        // coin-selection are materialized (getToken + engine decode) only now.
        await this.materializeSelectedSources(splitPlan);

        // E.3: persist the (client-encrypted — S6) intent and AWAIT the server
        // ack BEFORE any engine submit — the intent is the only resume seed
        // for a possibly-already-certified transfer; local-only persistence is
        // forbidden for the live path.
        if (walletApi) {
          await walletApi.putIntent(
            result.id,
            encryptField(
              this.getFieldEncryptionKey(),
              JSON.stringify(this.buildIntentPayload(request, peerInfo.chainPubkey, splitPlan))
            )
          );
        }

        // Deliver a journaled finished-token blob via the delivery port (S3:
        // the port replaced the direct relay leg; recipients are addressed by
        // CHAIN pubkey — the canonical identity).
        const deliverBlob = async (tokenBlob: string): Promise<void> => {
          // Carry the sender's own CANONICAL nametag so the recipient renders
          // "@name" instead of "Someone" — bundled with the memo in ONE
          // recipient-addressed envelope (S6).
          const nm = this.currentNametagName();
          await delivery.deliver(recipientChainPubkeyHex, hexToBytes(tokenBlob), {
            transferId: result.id,
            memo: request.memo,
            ...(nm !== undefined ? { senderNametag: nm } : {}),
          });
        };

        // Sources consumed by this send — the §7 step 6 apply (server path)
        // and the deferred local removals are driven from this list.
        const consumedSources: { uiTokenId: string; genesisId: string }[] = [];

        // Whole-token direct transfers. ONE realization seed per SEND
        // (ARCHITECTURE §7/§8.1): the intent transferId seeds every engine op,
        // so any device holding the wallet seed can rebuild the identical
        // transactions and resume (Part E).
        for (const [opIndex, tw] of splitPlan.tokensToTransferDirectly.entries()) {
          let finished;
          try {
            finished = await engine.transfer(
              {
                token: tw.sdkToken as SphereToken,
                recipientPubkey: recipientChainPubkey,
                data: memoData,
              },
              // opIndex = position in the persisted intent's `direct` order — the
              // stable (transferId, opIndex) pairing resume replays (§8.1).
              { signal: timeoutSignal(SEND_ENGINE_OP_TIMEOUT_MS), transferId: result.id, opIndex },
            );
          } catch (err) {
            // #625: tag for self-healing ONLY when nothing has certified yet in this attempt — re-planning
            // the full amount is then safe. If an earlier op already certified, the certified value has
            // left the wallet, so a full-amount re-plan would over-request; leave it untagged (no retry).
            if (err instanceof TransferConflictError && committedOnChainTokenIds.size === 0) {
              err.conflictedSourceId = tw.uiToken.id;
            }
            throw err;
          }
          // The source state is spent on-chain from here on.
          committedOnChainTokenIds.add(tw.uiToken.id);
          // Journal the finished blob BEFORE delivery: a transport failure or a
          // crash must not lose the recipient's token (replayed on next load()).
          const tokenBlob = bytesToHex(encodeTokenBlob(engine.encodeToken(finished)));
          await this.savePendingV2Delivery({
            transferId: result.id,
            recipientPubkey: recipientChainPubkeyHex,
            tokenBlob,
            memo: request.memo,
            opIndex,
            createdAt: Date.now(),
          });
          // §3.1 (#621): a delivery failure after certification must NOT fail the sender.
          if (!(await this.tryDeliver(() => deliverBlob(tokenBlob), tokenBlob))) deliveryPending = true;
          result.tokenTransfers.push({ sourceTokenId: tw.uiToken.id, method: 'direct' });
          consumedSources.push({
            uiTokenId: tw.uiToken.id,
            genesisId: extractTokenIdFromSdkData(tw.uiToken.sdkData) ?? tw.uiToken.id.replace(/^v2_/, ''),
          });
          // Server path: the removal is recorded by the single applyDelta
          // below (its evidence is the deposit just made); locally the source
          // is removed right away on the non-server path (unchanged behavior).
          if (!serverApply) await this.removeToken(tw.uiToken.id, result.id);
        }

        // Value-conserving split: recipient gets splitAmount, this wallet keeps
        // the remainder. The change token is real + immediate (the engine mints
        // it) — no placeholder / background-proof step.
        let changeOutput: SphereToken | null = null;
        if (splitPlan.requiresSplit && splitPlan.tokenToSplit) {
          const selfChainPubkey = hexToBytes(this.deps.identity.chainPubkey);
          let outputs;
          try {
            ({ outputs } = await engine.split(
              {
                token: splitPlan.tokenToSplit.sdkToken as SphereToken,
                outputs: [
                  { recipientPubkey: recipientChainPubkey, coinId: request.coinId, amount: splitPlan.splitAmount!, data: memoData },
                  { recipientPubkey: selfChainPubkey, coinId: request.coinId, amount: splitPlan.remainderAmount! },
                ],
              },
              // Same per-send seed; the split's opIndex follows the direct ops
              // (stable across resume — it is derived from the intent's order).
              {
                signal: timeoutSignal(SEND_ENGINE_OP_TIMEOUT_MS),
                transferId: result.id,
                opIndex: splitPlan.tokensToTransferDirectly.length,
              },
            ));
          } catch (err) {
            // #625: tag for self-healing only when nothing certified yet this attempt (see the direct-op
            // note) — a split after already-certified direct ops must not trigger a full-amount re-plan.
            if (err instanceof TransferConflictError && committedOnChainTokenIds.size === 0) {
              err.conflictedSourceId = splitPlan.tokenToSplit.uiToken.id;
            }
            throw err;
          }
          // The split source is burnt on-chain from here on. Journal the
          // recipient's blob BEFORE the delivery attempt.
          committedOnChainTokenIds.add(splitPlan.tokenToSplit.uiToken.id);
          const recipientBlob = bytesToHex(encodeTokenBlob(engine.encodeToken(outputs[0])));
          await this.savePendingV2Delivery({
            transferId: result.id,
            recipientPubkey: recipientChainPubkeyHex,
            tokenBlob: recipientBlob,
            memo: request.memo,
            opIndex: splitPlan.tokensToTransferDirectly.length,
            createdAt: Date.now(),
          });
          changeOutput = outputs[1];
          if (!serverApply) {
            // Non-server path: persist the change BEFORE the delivery attempt —
            // nothing after the on-chain split may depend on the transport
            // succeeding. On the server path the awaited intent (E.3) is the
            // recovery seed (a deterministic re-run rebuilds BOTH outputs), and
            // local storage follows the server apply below so the provider's
            // write-behind cannot race a second add of the same state.
            // critical (#515 F2): an unpersisted change token is value loss on
            // reload — fail the send (the open intent resumes it) rather than
            // report success.
            await this.storeEngineToken(engine, changeOutput, { criticalSave: true });
          }

          // §3.1 (#621): a delivery failure after certification must NOT fail the sender.
          if (!(await this.tryDeliver(() => deliverBlob(recipientBlob), recipientBlob))) deliveryPending = true;

          result.tokenTransfers.push({ sourceTokenId: splitPlan.tokenToSplit.uiToken.id, method: 'split' });
          consumedSources.push({
            uiTokenId: splitPlan.tokenToSplit.uiToken.id,
            genesisId:
              extractTokenIdFromSdkData(splitPlan.tokenToSplit.uiToken.sdkData) ??
              splitPlan.tokenToSplit.uiToken.id.replace(/^v2_/, ''),
          });
          if (!serverApply) await this.removeToken(splitPlan.tokenToSplit.uiToken.id, result.id);
        }

        if (serverApply) {
          // §7 steps 4+6: upload the change output, then record the whole
          // spend in ONE idempotent apply carrying the send's transferId. The
          // backend evidence-checks the removals against the mailbox deposit
          // of the same transferId (§5.3) and completes the intent in the
          // same transaction (§16).
          const added: { tokenId: string; key: string }[] = [];
          if (changeOutput) {
            const changeBytes = encodeTokenBlob(engine.encodeToken(changeOutput));
            added.push({ tokenId: engine.tokenId(changeOutput), key: await this.uploadOutputBlob(changeBytes) });
          }
          const storage = this.getActiveTokenStorageProvider();
          if (!storage) {
            throw new SphereError('No token storage provider available for applyDelta', 'STORAGE_ERROR');
          }
          await storage.applyDelta(
            result.id,
            consumedSources.map((s) => s.genesisId),
            added
          );
          // Local bookkeeping AFTER the server apply (see the ordering note
          // above): store the change, then drop the consumed sources.
          if (changeOutput) await this.storeEngineToken(engine, changeOutput);
          for (const s of consumedSources) await this.removeToken(s.uiTokenId, result.id);
        }
      }

      result.status = 'delivered';

      // Save state and remove outbox entry
      await this.save();
      await this.removeFromOutbox(result.id);

      result.status = 'completed';

      // E.3 uniform close: every finished send ends with completeIntent
      // (idempotent). With wallet-api inventory custody the apply above has
      // already completed it server-side (no-op); with own storage this call
      // is the ONLY close — without it every historical send would re-resume
      // at each sign-in forever.
      if (this.deps.walletApi) {
        try {
          await this.deps.walletApi.completeIntent(result.id);
        } catch (err) {
          logger.warn('Payments', 'completeIntent failed (the next sign-in resume converges it):', err);
        }
      }

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

      // §3.1 (#621): the spend is final regardless of delivery. If any leg's delivery was
      // deferred (recipient-side 429 / transient outage), resolve as delivery-pending — the
      // blob stays journaled for (re-)delivery — rather than failing the sender.
      if (deliveryPending) {
        result.deliveryPending = true;
        result.deliveryState = 'pending-delivery';
      } else {
        result.deliveryState = 'landed';
      }

      this.deps!.emitEvent(deliveryPending ? 'transfer:delivery_pending' : 'transfer:confirmed', result);
      return result;
    } catch (error) {
      // Cancel reservation — free reserved amounts for other sends
      this.reservationLedger.cancel(result.id);

      result.status = 'failed';
      // A TransferConflictError is a LOST RACE (Part E.2): another transaction —
      // typically this owner's other device — already consumed a source token.
      // Fail this send cleanly with a distinct message; the restore loop below
      // marks the conflicted source 'spent' via the on-chain isSpent check.
      // (Re-planning the uncovered remainder automatically is Part S.)
      result.error = error instanceof TransferConflictError
        ? `Send conflicted: a source token was already spent by a concurrent transfer — re-plan and retry (${error.message})`
        : error instanceof Error ? error.message : String(error);

      // #517 item 2: a TransferConflictError here is the predictable stale-view
      // race — coin-selection planned from a lazy-inventory view that missed
      // another device's spend. It is handled (abort + reconcile below) but was
      // otherwise SILENT; surface it as a distinct, recoverable signal so a UI
      // can prompt "refresh and retry" instead of just showing a generic failure.
      if (error instanceof TransferConflictError) {
        this.deps!.emitEvent('inventory:conflict', {
          transferId: result.id,
          coinId: request.coinId,
          error: error.message,
        });
      }

      // Intent disposition on failure (E.2/E.3):
      //  - a TransferConflictError aborts (the prescribed recovery — the
      //    caller re-plans under a NEW transferId; soft abort keeps the row);
      //    any already-certified legs stay journaled for delivery replay and
      //    converge via the recipient's claim handoff (§6);
      //  - a failure with NOTHING certified also aborts — an open intent would
      //    silently re-execute the transfer at the next sign-in after the user
      //    already saw it fail (and possibly retried it manually);
      //  - a partially-certified non-conflict failure keeps the intent OPEN:
      //    forward completion via resume is the only exit (§7).
      if (this.deps?.walletApi) {
        if (error instanceof TransferConflictError || committedOnChainTokenIds.size === 0) {
          try {
            await this.deps.walletApi.abortIntent(result.id);
          } catch (abortErr) {
            logger.warn('Payments', 'abortIntent failed (soft abort is best-effort):', abortErr);
          }
        }
      }

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
  // Private: wallet-api send pipeline helpers (sdk-changes S2/S3, E.3)
  // ===========================================================================

  /** The active (first, non-disabled) token storage provider — the lazy port. */
  private getActiveTokenStorageProvider(): TokenStorageProvider<TxfStorageDataBase> | null {
    const first = this.getTokenStorageProviders().values().next();
    return first.done ? null : first.value;
  }

  /** S6 field-encryption key for this identity (intent payloads, history memos). */
  private getFieldEncryptionKey(): Uint8Array {
    if (!this.fieldEncryptionKey) {
      this.fieldEncryptionKey = deriveFieldEncryptionKey(this.deps!.identity.privateKey);
    }
    return this.fieldEncryptionKey;
  }

  /**
   * S2: materialize the SELECTED lazy sources — fetch each blob on demand via
   * the storage port's `getToken()` and decode it through the engine. Only
   * tokens the plan actually consumes are downloaded; coin-selection itself
   * ran on the inventory view alone.
   */
  private async materializeSelectedSources(splitPlan: SplitPlan): Promise<void> {
    const selected: TokenWithAmount[] = [...splitPlan.tokensToTransferDirectly];
    if (splitPlan.tokenToSplit) selected.push(splitPlan.tokenToSplit);
    const pending = selected.filter((tw) => !tw.sdkToken);
    if (pending.length === 0) return;

    const engine = this.deps!.tokenEngine;
    const provider = this.getActiveTokenStorageProvider();
    if (!engine || !provider) {
      throw new SphereError(
        'Cannot materialize lazy sources — token engine or storage provider missing',
        'STORAGE_ERROR'
      );
    }
    for (const tw of pending) {
      const genesisId = tw.uiToken.id.replace(/^v2_/, '');
      const blob = await provider.getToken(genesisId);
      tw.sdkToken = await engine.decodeToken(blob);
      // Backfill sdkData so the downstream machinery (tombstones, restore
      // isSpent checks, archive) sees a complete token record.
      (tw.uiToken as { sdkData?: string }).sdkData = bytesToHex(encodeTokenBlob(blob));
      const live = this.tokens.get(tw.uiToken.id);
      if (live && live !== tw.uiToken) {
        (live as { sdkData?: string }).sdkData = (tw.uiToken as { sdkData?: string }).sdkData;
      }
    }
  }

  /**
   * Materialize one lazy inventory token for non-send spend paths such as
   * bridge-out burns. The send path goes through materializeSelectedSources();
   * bridgeBurn receives only a token id, so it must fetch the blob itself.
   */
  private async materializeTokenForEngine(token: Token): Promise<SphereToken> {
    const engine = this.deps!.tokenEngine;
    if (!engine) {
      throw new SphereError('Cannot materialize token — token engine missing', 'STORAGE_ERROR');
    }

    if (token.sdkData) {
      return engine.decodeToken(decodeTokenBlob(hexToBytes(token.sdkData)));
    }

    if (!token.lazy) {
      throw new SphereError(`Token ${token.id} has no token blob`, 'STORAGE_ERROR');
    }

    const provider = this.getActiveTokenStorageProvider();
    if (!provider) {
      throw new SphereError('Cannot materialize lazy token — storage provider missing', 'STORAGE_ERROR');
    }

    const genesisId = token.id.replace(/^v2_/, '');
    const blob = await provider.getToken(genesisId);
    const sdkToken = await engine.decodeToken(blob);
    const sdkData = bytesToHex(encodeTokenBlob(blob));
    (token as { sdkData?: string }).sdkData = sdkData;

    const live = this.tokens.get(token.id);
    if (live && live !== token) {
      (live as { sdkData?: string }).sdkData = sdkData;
    }

    return sdkToken;
  }

  /**
   * The E.3 intent payload — `{ sources, recipient, amounts }` concretized to
   * the realization plan, so a resume on ANY device rebuilds byte-identical
   * transactions (same transferId + same inputs + same output order).
   */
  private buildIntentPayload(
    request: TransferRequest,
    recipientChainPubkey: string,
    splitPlan: SplitPlan
  ): IntentPayloadV1 {
    const genesisIdOf = (tw: TokenWithAmount): string =>
      extractTokenIdFromSdkData(tw.uiToken.sdkData) ?? tw.uiToken.id.replace(/^v2_/, '');
    return {
      v: 1,
      recipient: recipientChainPubkey,
      coinId: request.coinId,
      amount: request.amount,
      ...(request.memo !== undefined ? { memo: request.memo } : {}),
      ...(request.invoiceRefundAddress !== undefined
        ? { invoiceRefundAddress: request.invoiceRefundAddress }
        : {}),
      ...(request.invoiceContact !== undefined ? { invoiceContact: request.invoiceContact } : {}),
      direct: splitPlan.tokensToTransferDirectly.map(genesisIdOf),
      ...(splitPlan.requiresSplit && splitPlan.tokenToSplit
        ? {
            split: {
              tokenId: genesisIdOf(splitPlan.tokenToSplit),
              splitAmount: splitPlan.splitAmount!.toString(),
              remainderAmount: splitPlan.remainderAmount!.toString(),
            },
          }
        : {}),
    };
  }

  /** §5.2: upload a spend output blob (content-addressed; 412 = present = success). */
  private async uploadOutputBlob(bytes: Uint8Array): Promise<string> {
    const walletApi = this.deps!.walletApi!;
    // §5.2/§8.2: the wire carries RAW token bytes — callers hand the sphere
    // envelope; unwrap at the wallet-api boundary.
    const wire = unwrapTokenBlobBytes(bytes);
    const sha = sha256(bytesToHex(wire), 'hex');
    const urls = await walletApi.getUploadUrls([{ sha256: sha, size: wire.length }]);
    const url = urls.find((u) => u.sha256 === sha);
    if (!url) {
      throw new SphereError(`upload-urls response missing sha256 ${sha}`, 'STORAGE_ERROR');
    }
    await walletApi.uploadBlob(url.putUrl, wire);
    return url.key;
  }

  /**
   * S2: project the storage provider's inventory view into the in-memory
   * token map as LAZY records — value metadata only, zero blob downloads.
   * Balances render from these; coin-selection plans from them; the blob is
   * fetched only when a token is selected to be spent.
   */
  private async mergeLazyInventory(provider: TokenStorageProvider<TxfStorageDataBase>): Promise<void> {
    const view = await provider.listInventory();
    if (view.items.length === 0) return;

    // Genesis ids already represented in memory (full or lazy records).
    const known = new Set<string>();
    for (const [, t] of this.tokens) {
      const genesisId =
        extractTokenIdFromSdkData(t.sdkData) ?? (t.id.startsWith('v2_') ? t.id.slice(3) : null);
      if (genesisId) known.add(genesisId);
    }

    let merged = 0;
    for (const item of view.items) {
      if (item.status !== 'active' || !item.assets || item.assets.length === 0) continue;
      if (known.has(item.tokenId)) continue;
      // The UI token model is single-asset (mirrors storeEngineToken).
      const asset = item.assets[0];
      const token: Token = {
        id: `v2_${item.tokenId}`,
        coinId: asset.coinId,
        symbol: this.getCoinSymbol(asset.coinId),
        name: this.getCoinName(asset.coinId),
        decimals: this.getCoinDecimals(asset.coinId),
        iconUrl: this.getCoinIconUrl(asset.coinId),
        amount: asset.amount.toString(),
        status: 'confirmed',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        lazy: true,
      };
      this.tokens.set(token.id, token);
      merged++;
    }
    if (merged > 0) {
      logger.debug('Payments', `load(): merged ${merged} lazy inventory record(s) — no blobs downloaded (S2)`);
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

    // S4: with the wallet-api payment-request capability composed, the
    // request rides the §16 endpoints — the Nostr channel is not used.
    const prApi = this.paymentRequestsApi();
    if (prApi) {
      return this.sendWalletApiPaymentRequest(prApi, recipientPubkeyOrNametag, request);
    }

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
      const requestId = randomUUID();

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
   * S4: create the request via wallet-api (§16). The payer is addressed by
   * CHAIN pubkey (the canonical identity); the memo is S6-encrypted client-
   * side BEFORE it leaves the device (§8.3) — the operator stores ciphertext.
   * Mirrors the transport path's no-throw contract: failures (including the
   * §5.5 per-payer cap → 429) come back as `{ success: false, error }`.
   */
  private async sendWalletApiPaymentRequest(
    api: PaymentRequestsApi,
    recipientPubkeyOrNametag: string,
    request: Omit<PaymentRequest, 'id' | 'createdAt'>
  ): Promise<PaymentRequestResult> {
    try {
      const peerInfo = await this.deps!.transport.resolve?.(recipientPubkeyOrNametag) ?? null;
      const toPubkey =
        peerInfo?.chainPubkey ??
        (/^0[23][0-9a-f]{64}$/i.test(recipientPubkeyOrNametag)
          ? recipientPubkeyOrNametag.toLowerCase()
          : null);
      if (!toPubkey) {
        return {
          success: false,
          error: `Recipient ${recipientPubkeyOrNametag} has no published identity (chain pubkey) — cannot receive payment requests.`,
        };
      }

      // S6: the requester's nametag + message ride ONE recipient-addressed
      // envelope keyed off ECDH(requesterPriv, PAYER chain pubkey) — symmetric,
      // so the payer re-derives it from its own key + this request's fromPubkey
      // (the PR twin of #546/#547). The self-scoped field key was wrong here:
      // a memo encrypted with the requester's key could never be opened by the
      // payer. Same `enc1.` XChaCha20-Poly1305 wire (operator-blind, backend-
      // valid — no wire/backend change); attached whenever there is a nametag
      // OR a message, so the payer renders "@requester" even with no message.
      const memoEnvelope = encryptDeliveryBundle(
        deriveDeliveryEncryptionKey(this.deps!.identity.privateKey, toPubkey),
        { senderNametag: this.currentNametagName(), memo: request.message }
      );

      const wire = await api.createPaymentRequest({
        toPubkey,
        // Amounts are decimal strings end-to-end (§11) — BigInt round-trips them exactly.
        assets: [{ coinId: request.coinId, amount: BigInt(request.amount) }],
        ...(memoEnvelope !== undefined ? { memo: memoEnvelope } : {}),
        ...(request.expiresAt !== undefined ? { expiresAt: request.expiresAt } : {}),
      });

      // Track the outgoing request under the SERVER id — the `?before=`
      // backfill refresh (refreshOutgoingPaymentRequests) matches on it.
      const outgoingRequest: OutgoingPaymentRequest = {
        id: wire.id,
        eventId: wire.id, // no relay event on this path — the server id stands in
        recipientPubkey: toPubkey,
        recipientNametag: recipientPubkeyOrNametag.startsWith('@')
          ? recipientPubkeyOrNametag.slice(1)
          : undefined,
        amount: request.amount,
        coinId: request.coinId,
        message: request.message,
        createdAt: wire.createdAt,
        status: 'pending',
      };
      this.outgoingPaymentRequests.set(wire.id, outgoingRequest);

      logger.debug('Payments', `Payment request created via wallet-api: ${wire.id}`);

      return {
        success: true,
        requestId: wire.id,
        eventId: wire.id,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.debug('Payments', `Failed to create wallet-api payment request: ${errorMsg}`);
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
   * On the wallet-api path (S4) the respond IS the state change — it is
   * confirmed server-side (`action: 'declined'`, §16) before the local status
   * flips, and a server rejection (403/409) propagates to the caller. The
   * transport path is best-effort and never throws.
   *
   * @param requestId - ID of the incoming payment request to reject.
   */
  async rejectPaymentRequest(requestId: string): Promise<void> {
    await this.sendPaymentRequestResponse(requestId, 'rejected');
    this.updatePaymentRequestStatus(requestId, 'rejected');
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

      // Mark as paid and send response with transfer ID. The transfer already
      // succeeded — a failed status link (e.g. an expiry race on the
      // wallet-api respond, §16) is logged, never reported as a failed payment.
      this.updatePaymentRequestStatus(requestId, 'paid');
      try {
        await this.sendPaymentRequestResponse(requestId, 'paid', result.id);
      } catch (error) {
        logger.warn('Payments', `Payment sent but the paid response failed for ${requestId}:`, error);
      }

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
          eventType === 'payment_request:paid' ||
          eventType === 'payment_request:expired') {
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
    // Convert transport response to PaymentRequestResponse
    this.dispatchPaymentRequestResponse({
      id: transportResponse.id,
      responderPubkey: transportResponse.responderTransportPubkey,
      requestId: transportResponse.response.requestId,
      responseType: transportResponse.response.responseType,
      message: transportResponse.response.message,
      transferId: transportResponse.response.transferId,
      timestamp: transportResponse.timestamp,
    });
  }

  /**
   * Fold a payment-request response into the outgoing surface and notify —
   * shared by the transport subscription and the wallet-api outgoing refresh
   * (S4): update the matched outgoing request, resolve any
   * {@link waitForPaymentResponse} waiter, emit the event, run the handlers.
   */
  private dispatchPaymentRequestResponse(response: PaymentRequestResponse): void {
    // Find the outgoing request by matching requestId
    let outgoingRequest: OutgoingPaymentRequest | undefined;
    let outgoingRequestId: string | undefined;

    for (const [id, request] of this.outgoingPaymentRequests) {
      // Match by eventId or requestId from the response
      if (request.eventId === response.requestId ||
          request.id === response.requestId) {
        outgoingRequest = request;
        outgoingRequestId = id;
        break;
      }
    }

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

    // S4: respond via the §16 endpoint. 'accepted' is a LOCAL UI state — the
    // backend models open → paid|declined|expired only, so nothing is sent
    // until the actual decision. Unlike the best-effort transport leg below,
    // server rejections (403 non-addressee / 409 non-open) propagate.
    const prApi = this.paymentRequestsApi();
    if (prApi) {
      if (responseType === 'accepted') return;
      if (responseType === 'paid') {
        if (transferId === undefined) {
          throw new SphereError('A paid response requires the fulfilling transferId (§16)', 'VALIDATION_ERROR');
        }
        await prApi.respondPaymentRequest(request.requestId, { action: 'paid', transferId });
      } else {
        await prApi.respondPaymentRequest(request.requestId, { action: 'declined' });
      }
      logger.debug('Payments', `Responded to payment request via wallet-api: ${responseType} for ${requestId}`);
      return;
    }

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

    // S3: with an injected delivery port the one-shot fetch IS a pump of the
    // port's incoming feed (mailbox pull) — Nostr is not used for assets.
    if (this.injectedDelivery) {
      const tokensBefore = new Set(this.tokens.keys());
      await this.pumpIncomingDeliveriesFresh();
      const received: IncomingTransfer[] = [];
      for (const [tokenId, token] of this.tokens) {
        if (tokensBefore.has(tokenId)) continue;
        const transfer: IncomingTransfer = {
          id: tokenId,
          senderPubkey: '',
          tokens: [token],
          receivedAt: Date.now(),
        };
        received.push(transfer);
        if (callback) callback(transfer);
      }
      return { transfers: received };
    }

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

    for (const token of this.tokens.values()) {
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
   * @param opts - `criticalSave: true` on user-facing flows (mint/send): a
   *   failed save of the ACTIVE custody provider then throws STORAGE_ERROR
   *   (#515 F2) instead of emitting `storage:degraded`.
   * @returns `true` if the token was added, `false` if rejected as duplicate or tombstoned.
   */
  async addToken(token: Token, opts: { criticalSave?: boolean } = {}): Promise<boolean> {
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

    await this.save({ critical: opts.criticalSave });
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
      id: randomUUID(),
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

    // §10: the server-side history log is CLIENT-written (the server never
    // writes rows), deduped by dedupKey. Memo + counterparty nametag are S6
    // envelopes — the operator never sees plaintext (§8.3). Best-effort: a
    // failed POST never fails the money path; the record stays local.
    const walletApi = this.deps!.walletApi;
    // §16 wire shape (strict server-side zod; caught drifting by the phase-2
    // harness — the fake had accepted the module's internal shape):
    //  - `id` (uuid) + `ts` (ISO-8601), never `timestamp`;
    //  - `type` is the §16 enum — anything else stays local-only;
    //  - `tokenId` is the genesis-stable lowercase hex (strip the `v2_` UI prefix);
    //  - `counterpartyPubkey` only when it IS a 33-byte compressed pubkey.
    const postableType = historyEntry.type === 'SENT' || historyEntry.type === 'RECEIVED' || historyEntry.type === 'MINT';
    if (walletApi && postableType) {
      try {
        const fieldKey = this.getFieldEncryptionKey();
        const counterpartyNametag = historyEntry.recipientNametag ?? historyEntry.senderNametag;
        const wireTokenId = historyEntry.tokenId?.replace(/^v2_/, '');
        const counterparty = historyEntry.recipientPubkey ?? historyEntry.senderPubkey;
        await walletApi.postHistoryRecords([
          {
            dedupKey: historyEntry.dedupKey,
            id: randomUUID(),
            type: historyEntry.type,
            ts: new Date(historyEntry.timestamp).toISOString(),
            assets: [{ coinId: historyEntry.coinId, amount: historyEntry.amount }],
            ...(historyEntry.transferId !== undefined ? { transferId: historyEntry.transferId } : {}),
            ...(wireTokenId !== undefined && /^(?:[0-9a-f]{2}){1,64}$/.test(wireTokenId)
              ? { tokenId: wireTokenId }
              : {}),
            ...(counterparty !== undefined && /^0[23][0-9a-f]{64}$/.test(counterparty)
              ? { counterpartyPubkey: counterparty }
              : {}),
            ...(historyEntry.memo !== undefined ? { memo: encryptField(fieldKey, historyEntry.memo) } : {}),
            ...(counterpartyNametag !== undefined
              ? { counterpartyNametag: encryptField(fieldKey, counterpartyNametag) }
              : {}),
          },
        ]);
      } catch (err) {
        logger.warn('Payments', 'history POST failed (kept locally; dedupKey makes retry safe):', err);
      }
    }

    // Notify listeners that a history entry was saved
    this.deps!.emitEvent('history:updated', historyEntry);
  }

  /**
   * Load history into the in-memory cache.
   *
   * In the wallet-api composition (the `walletApi` client is present) the
   * durable §10 history log lives on the SERVER — the thin storage provider
   * keeps none — so the cache is rebuilt from `walletApi.listHistory()`. The
   * twin of the #521 inventory reload bug: `_historyCache` is process-lifetime,
   * so a reload (tab refresh) must re-pull it or render an empty history.
   * Compositions WITHOUT `walletApi` keep the legacy local path below.
   */
  async loadHistory(): Promise<void> {
    if (this.deps!.walletApi?.listHistory) {
      await this.hydrateHistoryFromServer(this.deps!.walletApi);
      return;
    }
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
   * Rebuild `_historyCache` from the server's §10 history log (the wallet-api
   * composition). Pages newest-first via the keyset cursor until `more:false`
   * or the page cap; dedups by `dedupKey` (a hydrate-then-receive in the same
   * session must not double-list). The S6 `memo` / `counterpartyNametag`
   * envelopes are decrypted with the owner's own field key on the way in.
   *
   * Best-effort, like the §10 history POST: history is untrusted DISPLAY data,
   * so a backend outage during hydration must NEVER fail `load()` (the money
   * path) — the in-session cache is left intact and the pull retries next load.
   */
  private async hydrateHistoryFromServer(api: PaymentsWalletApiPort): Promise<void> {
    // #583 defense-in-depth owner guard: capture the owner this hydration ran
    // for and refuse to OVERWRITE `_historyCache` if the module's identity
    // changed under us (a re-init mid-pull). Per-address isolation pins the
    // client per owner so this can't normally happen; the guard ensures a stale
    // pull never replaces the active owner's history with another owner's.
    const owner = this.deps!.identity.chainPubkey;
    const byDedupKey = new Map<string, TransactionHistoryEntry>();
    try {
      let before: string | undefined;
      for (let page = 0; page < MAX_HISTORY_HYDRATION_PAGES; page++) {
        const result = await api.listHistory(before !== undefined ? { before } : {});
        for (const wire of result.records) {
          if (!byDedupKey.has(wire.dedupKey)) {
            byDedupKey.set(wire.dedupKey, this.historyEntryFromWire(wire));
          }
        }
        if (!result.more || result.cursor === null) break;
        before = result.cursor;
      }
    } catch (err) {
      logger.warn('Payments', 'history hydration from server failed (kept in-memory; retries next load):', err);
      return;
    }
    if (this.deps!.identity.chainPubkey !== owner) {
      logger.warn('Payments', 'history hydration owner changed mid-pull — discarding stale result (owner guard)');
      return;
    }
    this._historyCache = [...byDedupKey.values()];
  }

  /**
   * Map one §16 history wire record onto the display
   * {@link TransactionHistoryEntry}. `counterpartyNametag` lands on the role-
   * appropriate field (sender for RECEIVED, recipient otherwise); the S6 memo +
   * nametag envelopes decrypt under THIS wallet's field key (self-scoped at
   * rest — §8.3), surfaced as absent if they don't decrypt rather than as
   * ciphertext (same rule as mailbox/payment-request memos).
   */
  private historyEntryFromWire(wire: WalletApiHistoryRecord): TransactionHistoryEntry {
    const asset = wire.assets[0];
    const coinId = asset?.coinId ?? '';
    const received = wire.type === 'RECEIVED';
    const memo = this.tryDecryptField(wire.memo);
    const nametag = this.tryDecryptField(wire.counterpartyNametag);
    return {
      id: wire.id,
      dedupKey: wire.dedupKey,
      type: wire.type as TransactionHistoryEntry['type'],
      amount: asset?.amount ?? '0',
      coinId,
      symbol: this.getCoinSymbol(coinId),
      timestamp: Date.parse(wire.ts),
      ...(wire.transferId !== undefined ? { transferId: wire.transferId } : {}),
      ...(wire.tokenId !== undefined ? { tokenId: wire.tokenId } : {}),
      ...(wire.counterpartyPubkey !== undefined
        ? received
          ? { senderPubkey: wire.counterpartyPubkey }
          : { recipientPubkey: wire.counterpartyPubkey }
        : {}),
      ...(nametag !== undefined
        ? received
          ? { senderNametag: nametag }
          : { recipientNametag: nametag }
        : {}),
      ...(memo !== undefined ? { memo } : {}),
    };
  }

  /** S6 field decrypt that surfaces an undecryptable envelope as absent (§8.3). */
  private tryDecryptField(envelope?: string): string | undefined {
    if (envelope === undefined) return undefined;
    try {
      return decryptField(this.getFieldEncryptionKey(), envelope);
    } catch {
      return undefined;
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
   * The requester's CURRENT display nametag for outgoing memos: the canonical
   * Sphere-level (Nostr-backed) store first, then the local minted-token store.
   *
   * The minted-token `nametags[]` is populated only by the best-effort,
   * oracle-gated mint path, so in the real app it is empty at send time even
   * when the user has a nametag — reading it dropped the nametag from the
   * payment-request/delivery memo and the payer rendered a raw pubkey. The
   * canonical store (injected via `getCurrentNametag`) is the one the UI shows
   * and is reliably loaded on every startup. (#576, 6bd3058 regression)
   *
   * @returns The bare nametag name (no leading '@'), or `undefined`.
   */
  private currentNametagName(): string | undefined {
    return this.deps?.getCurrentNametag?.() ?? this.nametags[0]?.name;
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
   * Bridge-in mint (06 §A1.1): mint the bridged token a Tron lock funds. The
   * caller (the app's bridge flow) derives `tokenType` + the committed `salt`,
   * supplies bridge-owned `mintData` (bare SDK PaymentAssetCollection CBOR, not
   * SpherePaymentData(39050)), and builds `genesisReason`
   * (a `TronUsdtLockJustification` CBOR) from the on-chain `Lock` event.
   * `engine.mint` runs the registered bridge verifier on the reason
   * (re-checking the lock at `confirmations: 0` — the minter trusts its own lock),
   * then the finished token is stored as a confirmed, spendable balance.
   */
  async bridgeMint(params: {
    coinIdHex: string;
    amount: bigint;
    /** Raw bridge-owned mint data. Must not be SpherePaymentData(39050). */
    mintData: Uint8Array;
    tokenType: Uint8Array;
    salt: Uint8Array;
    genesisReason: Uint8Array;
    /** 06 §A1.1: pass a confirmations:0 self-mint verifier service (the caller
     * builds it via the bridge plugin's `buildSelfMintVerifierService`) so this
     * mint trusts the lock it just broadcast, instead of the K-confirmation
     * threshold `bridgeJustificationVerifiers` enforces everywhere else. */
    mintJustificationVerifierOverride?: MintJustificationVerifierService;
  }): Promise<{ success: true; token: Token; tokenId: string } | { success: false; error: string }> {
    this.ensureInitialized();
    const engine = this.deps?.tokenEngine;
    if (!engine) {
      return { success: false, error: 'Bridge mint requires the v2 token engine (no oracle trust base / url).' };
    }
    if (params.amount <= 0n) {
      return { success: false, error: 'Mint amount must be greater than zero' };
    }
    try {
      const minted = await engine.mint(
        {
          recipientPubkey: engine.getIdentity().chainPubkey,
          data: params.mintData,
          tokenType: params.tokenType,
          salt: params.salt,
          genesisReason: params.genesisReason,
        },
        { mintJustificationVerifierOverride: params.mintJustificationVerifierOverride },
      );
      const { uiToken } = await this.storeEngineToken(engine, minted, { criticalSave: true });
      return { success: true, token: uiToken, tokenId: engine.tokenId(minted) };
    } catch (err) {
      return { success: false, error: `Bridge mint failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * Bridge-out burn (06 §A1.2): burn a stored bridged token to
   * `BurnPredicate(reasonHash)` with `reasonBytes` in the aux data, via the engine.
   * The caller derives `reasonHash`/`reasonBytes` with the plugin's pure
   * derivations. Returns the burned blob + the certified state id / tx hash (for
   * nullifier/leaf). The source token is spent on-chain; reconciled on next
   * `validate()`/`sync()`. For a partial return, split first and pass the child id.
   */
  async bridgeBurn(params: {
    tokenId: string;
    reasonHash: Uint8Array;
    reasonBytes: Uint8Array;
  }): Promise<
    | { success: true; burnedTokenCbor: Uint8Array; burnStateId: Uint8Array; burnTxHash: Uint8Array }
    | { success: false; error: string }
  > {
    this.ensureInitialized();
    const engine = this.deps?.tokenEngine;
    if (!engine) return { success: false, error: 'Bridge burn requires the v2 token engine.' };
    const uiToken = this.getTokens().find((t) => t.id === params.tokenId);
    if (!uiToken) return { success: false, error: `Token ${params.tokenId} not found` };
    try {
      const sdkToken = await this.materializeTokenForEngine(uiToken);
      const result = await engine.bridgeBurn({ token: sdkToken, reasonHash: params.reasonHash, reasonBytes: params.reasonBytes });
      const cleanupId = randomUUID();
      try {
        const sourceTokenId = extractTokenIdFromSdkData(uiToken.sdkData);
        const storage = this.getActiveTokenStorageProvider();
        if (sourceTokenId && storage) {
          await storage.applyDelta(cleanupId, [sourceTokenId], []);
        }
        await this.removeToken(uiToken.id, cleanupId);
      } catch (cleanupErr) {
        logger.warn('Payments', `Bridge burn succeeded but local inventory cleanup failed for ${uiToken.id}:`, cleanupErr);
      }
      return { success: true, ...result };
    } catch (err) {
      return { success: false, error: `Bridge burn failed: ${err instanceof Error ? err.message : String(err)}` };
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
    opts: { criticalSave?: boolean } = {},
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
    const added = await this.addToken(uiToken, opts);
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
      // #515 F2: the mint is user-facing — a failed save of the ACTIVE custody
      // provider must fail the mint (a RAM-only blob behind a success modal is
      // permanent loss on reload), not report success.
      const { uiToken } = await this.storeEngineToken(engine, minted, { criticalSave: true });
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

      // Sync with each provider
      for (const [providerId, provider] of providers) {
        try {
          const result = await provider.sync(localData);

          if (result.success && result.merged) {
            // Address guard: reject data from a different address.
            // Stale IPFS records may contain tokens from a previously active
            // address if a write-behind flush raced with an address switch.
            const mergedMeta = (result.merged as TxfStorageDataBase)?._meta;
            const currentChain = this.deps!.identity.chainPubkey;
            const isLegacyAlpha = mergedMeta?.address?.startsWith('alpha1') ?? false;
            if (mergedMeta?.address && currentChain && !isLegacyAlpha && mergedMeta.address !== currentChain) {
              logger.warn('Payments', `Sync: rejecting data from provider ${providerId} — address mismatch (got=${mergedMeta.address.slice(0, 20)}... expected=${currentChain.slice(0, 20)}...)`);
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
   *
   * Transport-agnostic (sdk-changes S3): fed by the relay push subscription
   * AND by the delivery port's incoming pump — the returned verdict lets the
   * pump map outcomes onto `ack('claimed' | 'rejected')`.
   */
  private async handleV2Transfer(
    payload: V2TransferPayload,
    senderPubkey: string
  ): Promise<'stored' | 'duplicate' | 'storage-rejected' | 'invalid' | 'not-owned' | 'no-engine'> {
    this.ensureInitialized();
    if (!this.loaded && this.loadedPromise) {
      await this.loadedPromise;
    }

    const engine = this.deps!.tokenEngine;
    if (!engine) {
      logger.error('Payments', 'V2 transfer received but no token engine is configured — payload dropped. Supply the v2 oracle config (trust base + gateway URL).');
      return 'no-engine';
    }

    let token: SphereToken;
    try {
      // Tolerant read: peers/journals carry the sphere envelope, while the
      // wallet-api mailbox serves RAW wire bytes (§5.2/§8.2). Either way the
      // engine's decode re-derives the authoritative blob from the token
      // itself, so the placeholder fields of a raw wrap are never trusted.
      const bytes = hexToBytes(payload.tokenBlob);
      let blob: TokenBlob;
      try {
        blob = decodeTokenBlob(bytes);
      } catch {
        blob = { v: TOKEN_BLOB_VERSION, network: 0, tokenId: '', token: bytes };
      }
      token = await engine.decodeToken(blob);
    } catch (err) {
      logger.error('Payments', 'V2 transfer: failed to decode token blob:', err);
      return 'invalid';
    }

    // Security: the sender hands us a FINISHED token — verify it cryptographically
    // and confirm its final state is actually locked to this wallet before it
    // enters the balance. Both checks are local (trust base + predicate bytes).
    const verdict = await engine.verify(token);
    if (!verdict.ok) {
      logger.warn('Payments', `V2 transfer rejected: verification failed (${verdict.reason ?? 'unknown'})`);
      return 'invalid';
    }
    if (!engine.isOwnedBy(token, engine.getIdentity().chainPubkey)) {
      logger.warn('Payments', 'V2 transfer rejected: token not addressed to this wallet');
      return 'not-owned';
    }

    // Dedup by genesis-stable id (a re-delivered identical token is ignored).
    const id = `v2_${engine.tokenId(token)}`;
    if (this.tokens.has(id)) {
      logger.debug('Payments', `V2 transfer ${id.slice(0, 16)}... already present, skipping`);
      return 'duplicate';
    }

    const { uiToken, added } = await this.storeEngineToken(engine, token);
    if (!added) {
      // Storage rejected it: a tombstoned re-delivery of a since-spent state, or
      // a duplicate race. Emitting transfer:incoming / writing RECEIVED history
      // here would announce a phantom payment for value the wallet does not hold.
      logger.warn('Payments', `V2 transfer ${id.slice(0, 16)}... rejected by storage (tombstoned/duplicate) — no event emitted`);
      return 'storage-rejected';
    }
    // The sender's nametag rides the recipient-addressed delivery envelope
    // (S6) — the PRIMARY counterparty identity. resolveSenderInfo (a Nostr
    // transport-pubkey lookup that does NOT understand chain pubkeys) is only a
    // best-effort FALLBACK and never gates receive.
    const senderInfo = await this.resolveSenderInfo(senderPubkey);
    const senderNametag = payload.senderNametag ?? senderInfo.senderNametag;

    this.deps!.emitEvent('transfer:incoming', {
      id,
      senderPubkey,
      senderNametag,
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
      ...(senderNametag !== undefined ? { senderNametag } : {}),
      memo: payload.memo,
      tokenId: id,
    });
    return 'stored';
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
  // Delivery port: incoming pump + intent resume (sdk-changes S3/E.3)
  // ===========================================================================

  private teardownDeliveryPump(): void {
    this.deliveryWakeUnsub?.();
    this.deliveryWakeUnsub = null;
    if (this.deliveryPollTimer !== null) {
      clearInterval(this.deliveryPollTimer);
      this.deliveryPollTimer = null;
    }
    if (this.inventoryPollTimer !== null) {
      clearInterval(this.inventoryPollTimer);
      this.inventoryPollTimer = null;
    }
  }

  /**
   * Route a §9 wake nudge to the matching stream's pull. The wake is
   * best-effort — each branch also runs on a poll backstop, so a dropped wake
   * only delays convergence, never breaks it:
   * - `mailbox` → drain incoming deliveries;
   * - `inventory` → debounced inventory resync (the owned-token set changed —
   *   e.g. a top-up or a claim on another device/session);
   * - `payment_requests` → pump the payment-request streams.
   */
  private handleWake(stream: WakeStream): void {
    switch (stream) {
      case 'mailbox':
        void this.pumpIncomingDeliveries().catch((err) =>
          logger.warn('Payments', 'Incoming delivery pump (wake) failed:', err)
        );
        return;
      case 'inventory':
        this.debouncedInventorySyncFromWake();
        return;
      case 'payment_requests':
        void this.pumpPaymentRequests().catch((err) =>
          logger.warn('Payments', 'Payment-request pump (wake) failed:', err)
        );
        return;
    }
  }

  /**
   * Debounced inventory resync driven by an `inventory` wake — coalesces a
   * burst of wakes into one pull. Runs the same {@link resyncInventory} as the
   * poll backstop: a wake just makes it fire sooner.
   */
  private debouncedInventorySyncFromWake(): void {
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
    }
    this.syncDebounceTimer = setTimeout(() => {
      this.syncDebounceTimer = null;
      void this.resyncInventory().catch((err) =>
        logger.debug('Payments', 'Inventory resync (wake) failed:', err)
      );
    }, PaymentsModule.SYNC_DEBOUNCE_MS);
  }

  /**
   * Pull the wallet-api inventory delta and re-merge the lazy view (§5.1/§9):
   * a fresh {@link load} re-pulls from the durable cursor and re-merges the
   * owned-token set, then emits the existing `sync:remote-update` so the
   * frontend's realtime view lights up (the same event the storage `onEvent`
   * path emits — DEAD in custodial mode without this). The owned-token count
   * delta stands in for the per-provider add/remove counts (the thin provider's
   * `sync()` reports none). Used by BOTH the `inventory` wake and the poll
   * backstop, so convergence never depends on a wake arriving.
   */
  private async resyncInventory(): Promise<void> {
    const before = this.tokens.size;
    await this.load();
    const after = this.tokens.size;
    this.deps?.emitEvent('sync:remote-update', {
      providerId: 'wallet-api',
      name: 'inventory',
      sequence: 0,
      cid: '',
      added: Math.max(0, after - before),
      removed: Math.max(0, before - after),
    });
  }

  /**
   * Drain the delivery port's incoming feed through the transport-agnostic
   * `handleV2Transfer` and acknowledge each delivery (S3):
   * - verified + stored (or an idempotent duplicate) → `ack('claimed')`;
   * - failed LOCAL verification / not addressed here / stale tombstoned
   *   state → `ack('rejected')` (terminal for discovery only — the entry
   *   stays claimable and its blob retained, §6) and surfaced to the app as
   *   `transfer:invalid`;
   * - engine unavailable / fetch failure → left unacknowledged (retried on
   *   the next poll; the read pointer cannot advance past it, by design).
   *
   * Returns the number of newly stored tokens. Concurrent calls coalesce.
   */
  async pumpIncomingDeliveries(): Promise<number> {
    if (!this.injectedDelivery) return 0;
    if (this.pumpInFlight) return this.pumpInFlight;
    this.pumpInFlight = this.doPumpIncomingDeliveries().finally(() => {
      this.pumpInFlight = null;
    });
    return this.pumpInFlight;
  }

  /**
   * receive() must observe deliveries present as of NOW — it must never coalesce
   * onto a background pump (§9 wake/poll) that began before a just-arrived
   * delivery, which would return without loading it. Await any in-flight pump,
   * then start a fresh pull (a background pump's failure must not fail receive()).
   */
  private async pumpIncomingDeliveriesFresh(): Promise<number> {
    const inFlight = this.pumpInFlight;
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        // re-pull regardless: a stale background pump's failure is not receive()'s
      }
    }
    return this.pumpIncomingDeliveries();
  }

  private async doPumpIncomingDeliveries(): Promise<number> {
    const delivery = this.injectedDelivery!;
    if (!this.loaded && this.loadedPromise) {
      await this.loadedPromise;
    }
    let stored = 0;
    // #623: verify+store per entry (§8.2 — the recipient verifies locally), but ACCUMULATE the
    // claim/reject and submit them in batches (one request each) so a large inbox drain doesn't fire
    // one write per entry and trip the per-owner rate limit. Crash-safe: the seen-set (added only on a
    // successful batch ack) is the replay guard and the cursor is the conservative §6 read pointer, so
    // an un-flushed batch is simply re-listed and re-processed (idempotent claim, §6).
    const claimed: string[] = [];
    const rejected: string[] = [];
    const flush = async (): Promise<void> => {
      if (claimed.length === 0 && rejected.length === 0) return;
      await this.flushIncomingAcks(delivery, claimed.splice(0), rejected.splice(0));
    };
    for await (const incoming of delivery.incoming()) {
      try {
        const verdict = await this.classifyIncomingDelivery(incoming);
        if (verdict.disposition === 'claimed') {
          claimed.push(incoming.deliveryId);
          if (verdict.stored) stored++;
        } else {
          rejected.push(incoming.deliveryId);
          // Surface as an invalid incoming payment (the actual reject is submitted in the flush).
          this.deps!.emitEvent('transfer:invalid', {
            deliveryId: incoming.deliveryId,
            senderPubkey: incoming.senderPubkey,
            reason: verdict.reason,
          });
        }
        if (claimed.length + rejected.length >= INCOMING_ACK_BATCH_SIZE) await flush();
      } catch (err) {
        // Transient (network, blob fetch / no-engine on THIS entry, or a threshold batch-flush
        // failure): leave the affected entr(ies) unacked — they are not in the seen-set, so the next
        // poll re-lists and re-processes them. Discovery of LATER entries continues.
        logger.warn(
          'Payments',
          `Incoming delivery ${incoming.deliveryId.slice(0, 12)}… (or its batch flush) failed transiently — left unacked, retried next poll:`,
          err
        );
      }
    }
    // A final-flush failure (transient claim/reject) is safe-by-replay — the entries are not in the
    // seen-set, so the next pump re-lists and re-processes them. Degrade gracefully rather than
    // propagating a pump crash (a 30s poll-restart).
    try {
      await flush();
    } catch (err) {
      logger.warn('Payments', 'Incoming ack flush failed — entries kept for the next pump (replay-safe):', err);
    }
    return stored;
  }

  /**
   * Verify + store an incoming delivery (§8.2 — local), returning the ack disposition WITHOUT acking
   * — the pump batches the claim/reject (#623). A `duplicate` still claims (idempotent §6, advances
   * the read pointer); `no-engine` throws so the entry is left unacked for a later pump.
   */
  private async classifyIncomingDelivery(
    incoming: IncomingDelivery
  ): Promise<{ disposition: 'claimed'; stored: boolean } | { disposition: 'rejected'; reason: string }> {
    const bytes = await incoming.fetchBlob();
    const payload: V2TransferPayload = {
      type: 'V2_TRANSFER',
      version: '2.0',
      tokenBlob: bytesToHex(bytes),
      // memo + senderNametag both ride the recipient-addressed delivery envelope (S6) the provider
      // already decrypted — the nametag is the PRIMARY counterparty identity (no Nostr lookup).
      memo: incoming.memo,
      ...(incoming.senderNametag !== undefined ? { senderNametag: incoming.senderNametag } : {}),
    };
    const verdict = await this.handleV2Transfer(payload, incoming.senderPubkey ?? '');
    switch (verdict) {
      case 'stored':
        return { disposition: 'claimed', stored: true };
      case 'duplicate':
        return { disposition: 'claimed', stored: false };
      case 'invalid':
      case 'not-owned':
      case 'storage-rejected':
        // Local verification failed (or the state is stale/tombstoned here): reject — terminal for
        // DISCOVERY only; the entry stays claimable and its blob retained (§6).
        return { disposition: 'rejected', reason: verdict };
      case 'no-engine':
        throw new SphereError('Token engine unavailable for incoming delivery', 'AGGREGATOR_ERROR');
    }
  }

  /**
   * Submit a batch of claims/rejects via the provider's batch ack (#623), falling back to per-entry
   * ack for a provider without it (e.g. the relay no-op).
   */
  private async flushIncomingAcks(
    delivery: DeliveryProvider,
    claimed: string[],
    rejected: string[]
  ): Promise<void> {
    if (delivery.ackBatch) {
      await delivery.ackBatch(claimed, rejected);
      return;
    }
    for (const id of claimed) await delivery.ack(id, 'claimed');
    for (const id of rejected) await delivery.ack(id, 'rejected');
  }

  // ===========================================================================
  // wallet-api payment requests: incoming pump + outgoing refresh (S4 — §10/§16)
  // ===========================================================================

  /** The S4 capability slice — null unless the composed wallet-api port carries it. */
  private paymentRequestsApi(): PaymentRequestsApi | null {
    const api = this.deps?.walletApi;
    if (
      !api ||
      typeof api.createPaymentRequest !== 'function' ||
      typeof api.listPaymentRequests !== 'function' ||
      typeof api.respondPaymentRequest !== 'function'
    ) {
      return null;
    }
    return api as PaymentRequestsApi;
  }

  private teardownPaymentRequestPump(): void {
    if (this.prPollTimer !== null) {
      clearInterval(this.prPollTimer);
      this.prPollTimer = null;
    }
  }

  // ── persisted cursor (per network + identity — mirrors the mailbox cursor) ──

  private prCursorKey(): string {
    const network = this.paymentRequestsApi()?.network ?? 'default';
    return `wallet-api-pr:cursor:${network}:${this.deps!.identity.chainPubkey}`;
  }

  private async readPrCursorState(): Promise<{ cursor: bigint; syncEpoch: bigint } | null> {
    const raw = await this.deps!.storage.get(this.prCursorKey());
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { cursor?: string; syncEpoch?: string };
      if (typeof parsed.cursor !== 'string' || typeof parsed.syncEpoch !== 'string') return null;
      return { cursor: BigInt(parsed.cursor), syncEpoch: BigInt(parsed.syncEpoch) };
    } catch {
      return null;
    }
  }

  private async persistPrCursorState(cursor: bigint, syncEpoch: bigint): Promise<void> {
    await this.deps!.storage.set(
      this.prCursorKey(),
      JSON.stringify({ cursor: cursor.toString(), syncEpoch: syncEpoch.toString() })
    );
  }

  // ── the pump ─────────────────────────────────────────────────────────────────

  /**
   * Pull the wallet-api payment-request streams now (S4): drains the payer's
   * incoming `?since=<seq>` stream (gap-free — §9/§16) into the existing
   * handler/event surface and refreshes outgoing requests still awaiting a
   * response. The poll interval and `load()` call this automatically; it is
   * public for explicit fetch-now flows (mirrors {@link receive}). A no-op in
   * compositions without the wallet-api payment-request capability — there
   * the Nostr subscription is push-based.
   */
  async syncPaymentRequests(): Promise<void> {
    await this.pumpPaymentRequests();
  }

  /** Coalesces concurrent pump runs (poll + wake + load can overlap). */
  private async pumpPaymentRequests(): Promise<void> {
    const api = this.paymentRequestsApi();
    if (!api) return;
    if (this.prPumpInFlight) return this.prPumpInFlight;
    this.prPumpInFlight = this.doPumpPaymentRequests(api).finally(() => {
      this.prPumpInFlight = null;
    });
    return this.prPumpInFlight;
  }

  private async doPumpPaymentRequests(api: PaymentRequestsApi): Promise<void> {
    if (!this.loaded && this.loadedPromise) {
      await this.loadedPromise;
    }
    await this.pumpIncomingPaymentRequests(api);
    await this.refreshOutgoingPaymentRequests(api);
  }

  /**
   * Drain the payer's gap-free `?since=<seq>` stream (§9/§16), mirroring the
   * mailbox-cursor pattern: the persisted `{cursor, syncEpoch}` is the resume
   * point; a `syncEpoch` change (server restore — §5.4) voids cursor
   * continuity, so the tail re-pulls from 0 and the id-dedup in
   * {@link surfaceIncomingPaymentRequest} absorbs the replays.
   *
   * Because the surfaced list is in-memory only, each session FIRST runs one
   * full incoming hydration from `since=0` with NO status filter (#556 —
   * mirrors {@link hydrateHistoryFromServer}): a fresh engine rebuilds the
   * CURRENT state of ALL incoming requests — open AND resolved — so a request
   * paid/declined/expired in a PRIOR session is still present (with its
   * resolved status) instead of vanishing once the cursor advanced past it.
   * Hydration NEVER fires the new-incoming handlers/events for resolved
   * requests — only `open` ones notify (the status-aware
   * {@link surfaceIncomingPaymentRequest}) — so reopening can't spam stale
   * 'new request' notifications. After hydration the `since`-cursor delta poll
   * picks up live updates from the resume point.
   */
  private async pumpIncomingPaymentRequests(api: PaymentRequestsApi): Promise<void> {
    const persisted = await this.readPrCursorState();

    if (!this.prBootstrapped) {
      let scan = await api.listPaymentRequests({ role: 'incoming', since: 0n });
      for (let pageCount = 0; pageCount < MAX_PR_HYDRATION_PAGES; pageCount++) {
        for (const wire of scan.requests) this.surfaceIncomingPaymentRequest(wire);
        if (!scan.more) break;
        scan = await api.listPaymentRequests({ role: 'incoming', since: scan.cursor });
      }
      // Marked only after the hydration SUCCEEDS — a transient failure here must
      // not skip recovery for the rest of the session (the next poll retries;
      // the id-dedup makes a re-hydration safe).
      this.prBootstrapped = true;
    }

    let page = await api.listPaymentRequests({ role: 'incoming', since: persisted?.cursor ?? 0n });
    if (persisted !== null && page.syncEpoch !== persisted.syncEpoch) {
      page = await api.listPaymentRequests({ role: 'incoming', since: 0n });
    }
    for (;;) {
      for (const wire of page.requests) this.surfaceIncomingPaymentRequest(wire);
      await this.persistPrCursorState(page.cursor, page.syncEpoch);
      if (!page.more) break;
      page = await api.listPaymentRequests({ role: 'incoming', since: page.cursor });
    }
  }

  /**
   * Decrypt a payment-request's recipient-addressed memo envelope into
   * `{ memo, senderNametag }` (the requester's message + nametag). The key is
   * the ECDH shared secret between THIS wallet (the payer) and the requester's
   * chain pubkey (`wire.fromPubkey`) — symmetric with the requester's
   * create-time derivation. Returns an empty bundle (and logs at debug) on any
   * absence/failure so the incoming view never wedges on an unreadable memo
   * (PR twin of #546/#547).
   */
  private decryptPaymentRequestMemo(
    wire: WalletApiPaymentRequest
  ): { memo?: string; senderNametag?: string } {
    if (wire.memo === undefined) return {};
    try {
      const key = deriveDeliveryEncryptionKey(this.deps!.identity.privateKey, wire.fromPubkey);
      return decryptDeliveryBundle(key, wire.memo);
    } catch {
      logger.debug('Payments', `Payment request ${wire.id.slice(0, 12)}… memo not addressed here / not decryptable`);
      return {};
    }
  }

  /** §16 wire status → the public {@link PaymentRequestStatus} display status. */
  private static readonly PR_WIRE_STATUS: Record<
    WalletApiPaymentRequest['status'],
    PaymentRequestStatus
  > = { open: 'pending', paid: 'paid', declined: 'rejected', expired: 'expired' };

  /** Terminal local statuses: a re-surfaced wire may advance a request INTO one, never out of it. */
  private static readonly PR_TERMINAL: ReadonlySet<PaymentRequestStatus> = new Set([
    'paid',
    'rejected',
    'expired',
  ]);

  /**
   * Map a §16 wire request onto the public {@link IncomingPaymentRequest}
   * surface, deduped by id (the in-memory id-dedup doubles as the replay guard
   * for cursor resets). Requests of EVERY status are surfaced so a reloaded
   * thin wallet rebuilds the CURRENT state of its incoming view (#556) — open
   * ones land as actionable `pending`, resolved ones carry their paid/declined
   * (→ `rejected`)/expired status. Only `open` requests fire the new-incoming
   * event + handlers; resolved requests are folded into the list silently, so a
   * reload (or a `syncEpoch` re-pull) never re-notifies for already-resolved
   * requests. Multi-asset requests surface their first asset (the module's
   * request surface is single-asset; module-created requests always are).
   */
  private surfaceIncomingPaymentRequest(wire: WalletApiPaymentRequest): void {
    // #583 defense-in-depth owner guard: only surface requests actually
    // addressed to THIS module's owner. Per-address client isolation means an
    // orphaned previous-address PR pump runs against its OWN client (its own
    // owner), so a wire for a different owner should never arrive here — but if
    // any shared state ever slips through, this drops it (and keeps it out of
    // the wrong owner's actionable view + cursor) rather than bleeding a foreign
    // request across addresses. Mirrors the engine.isOwnedBy delivery guard.
    if (wire.toPubkey !== this.deps!.identity.chainPubkey) {
      logger.warn(
        'Payments',
        `Incoming payment request ${wire.id.slice(0, 12)}… addressed to a different owner — skipping (owner guard)`
      );
      return;
    }

    const status = PaymentsModule.PR_WIRE_STATUS[wire.status];

    // §16 upsert: a request re-surfaces in the incoming ?since= delta at a higher seq when it is
    // resolved (paid/declined) or expired — on another device OR by THIS wallet's other session.
    // If we already hold it, advance a still-actionable request to its terminal server state and
    // emit the resolution event (so every session drops it from the actionable view); never
    // downgrade, and never re-notify a request we've already surfaced.
    const existing = this.paymentRequests.find((r) => r.id === wire.id);
    if (existing !== undefined) {
      if (PaymentsModule.PR_TERMINAL.has(status) && !PaymentsModule.PR_TERMINAL.has(existing.status)) {
        this.updatePaymentRequestStatus(wire.id, status);
      }
      return;
    }

    const coinId = wire.assets[0]?.coinId ?? '';
    const coinDef = TokenRegistry.getInstance().getDefinition(coinId);

    // S6: the memo is a recipient-addressed envelope keyed off
    // ECDH(payerPriv, requester chain pubkey = wire.fromPubkey) — symmetric
    // with the requester's create-time derivation (the PR twin of #546/#547).
    // It carries the requester's nametag AND message, so the payer renders
    // "@requester" + the message instead of a raw pubkey. An envelope not
    // addressed here, or any tamper, fails authentication and surfaces as
    // absent — never garbage, and never thrown into the view path. Decrypted
    // for resolved requests too (#554/dev.12), so a reloaded view renders the
    // memo/nametag of a paid/declined request, not a raw pubkey.
    const { memo: message, senderNametag } = this.decryptPaymentRequestMemo(wire);

    const request: IncomingPaymentRequest = {
      id: wire.id,
      senderPubkey: wire.fromPubkey,
      ...(senderNametag !== undefined ? { senderNametag } : {}),
      amount: (wire.assets[0]?.amount ?? 0n).toString(),
      coinId,
      symbol: coinDef?.symbol || coinId.slice(0, 8),
      ...(message !== undefined ? { message } : {}),
      requestId: wire.id,
      timestamp: wire.createdAt,
      status,
    };

    // Add to list (newest first)
    this.paymentRequests.unshift(request);

    // Notify ONLY for actionable (open) requests — a reload-hydrated resolved
    // request must not re-fire 'new incoming request' (#556). Open requests
    // surfaced during hydration DO notify, exactly as the prior bootstrap did.
    if (status === 'pending') {
      this.deps?.emitEvent('payment_request:incoming', request);
      for (const handler of this.paymentRequestHandlers) {
        try {
          handler(request);
        } catch (error) {
          logger.debug('Payments', 'Payment request handler error:', error);
        }
      }
    }

    logger.debug('Payments', `Incoming payment request: ${request.id} (${status}) for ${request.amount} ${request.symbol}`);
  }

  /**
   * Outgoing requests are a `?before=` backfill view (§16 — newest-first, no
   * gap-free tail): refresh only while something local still awaits a
   * response, paging until every pending id is resolved or the view drains.
   */
  private async refreshOutgoingPaymentRequests(api: PaymentRequestsApi): Promise<void> {
    const pendingIds = new Set(
      [...this.outgoingPaymentRequests.values()].filter((r) => r.status === 'pending').map((r) => r.id)
    );
    if (pendingIds.size === 0) return;

    let before: string | undefined;
    for (;;) {
      const page = await api.listPaymentRequests({
        role: 'outgoing',
        ...(before !== undefined ? { before } : {}),
      });
      for (const wire of page.requests) {
        if (!pendingIds.delete(wire.id)) continue;
        this.applyOutgoingPaymentRequestState(wire);
      }
      if (pendingIds.size === 0 || !page.more || page.cursor === null) return;
      before = page.cursor;
    }
  }

  /** Fold a server-side status change into the outgoing surface (responses + expiry). */
  private applyOutgoingPaymentRequestState(wire: WalletApiPaymentRequest): void {
    if (wire.status === 'open') return;
    const outgoing = this.outgoingPaymentRequests.get(wire.id);
    if (!outgoing || outgoing.status !== 'pending') return;

    if (wire.status === 'expired') {
      // §10: expiry is server-owned, not client-inferred — fold the status in;
      // there is no responder, so no response is dispatched.
      outgoing.status = 'expired';
      return;
    }

    this.dispatchPaymentRequestResponse({
      id: wire.id,
      responderPubkey: wire.toPubkey,
      requestId: wire.id,
      responseType: wire.status === 'paid' ? 'paid' : 'rejected',
      ...(wire.transferId !== null ? { transferId: wire.transferId } : {}),
      timestamp: Date.now(),
    });
  }

  /**
   * E.3 resume: list this wallet's OPEN intents (server-side — any device),
   * decrypt each payload, and re-run the engine with the SAME transferId and
   * inputs — deterministic realization yields byte-identical transactions, so
   * an interrupted transfer completes instead of failing (proof fetch →
   * match-verify → apply, Part E). Called at sign-in (S4).
   */
  async resumeOpenIntents(): Promise<{ resumed: string[]; conflicted: string[]; failed: string[] }> {
    this.ensureInitialized();
    const walletApi = this.deps!.walletApi;
    const engine = this.deps!.tokenEngine;
    const outcome = { resumed: [] as string[], conflicted: [] as string[], failed: [] as string[] };
    if (!walletApi || !engine) return outcome;
    if (!this.loaded && this.loadedPromise) {
      await this.loadedPromise;
    }

    const intents = await walletApi.listIntents('open');
    for (const intent of intents) {
      let payload: IntentPayloadV1;
      try {
        const plain = decryptField(this.getFieldEncryptionKey(), intent.payload);
        payload = JSON.parse(plain) as IntentPayloadV1;
        if (payload.v !== 1 || !Array.isArray(payload.direct)) {
          throw new SphereError('Unknown intent payload shape', 'VALIDATION_ERROR');
        }
      } catch (err) {
        logger.warn('Payments', `Intent ${intent.transferId.slice(0, 8)}… payload undecodable — skipped:`, err);
        outcome.failed.push(intent.transferId);
        continue;
      }
      try {
        await this.resumeIntent(intent.transferId, payload);
        outcome.resumed.push(intent.transferId);
      } catch (err) {
        if (err instanceof TransferConflictError) {
          // E.2 lost race: abort (soft), never apply the foreign proof. The
          // caller re-plans the remainder under a NEW transferId.
          logger.warn('Payments', `Intent ${intent.transferId.slice(0, 8)}… lost its source to a concurrent transfer — aborted`);
          try {
            await walletApi.abortIntent(intent.transferId);
          } catch (abortErr) {
            logger.warn('Payments', 'abortIntent during resume failed:', abortErr);
          }
          outcome.conflicted.push(intent.transferId);
        } else {
          // Transient — the intent stays open; the next sign-in retries.
          logger.warn('Payments', `Intent ${intent.transferId.slice(0, 8)}… resume failed (stays open):`, err);
          outcome.failed.push(intent.transferId);
        }
      }
    }
    return outcome;
  }

  /**
   * Re-run one intent end-to-end: getToken (works for tombstoned rows — §5.3
   * recovery surface), engine re-run under the original transferId, journaled
   * delivery, the single §7 apply (inventory custody only), uniform close,
   * and the SENT history record (dedupKey'd by transferId — idempotent).
   */
  private async resumeIntent(transferId: string, payload: IntentPayloadV1): Promise<void> {
    const engine = this.deps!.tokenEngine!;
    const walletApi = this.deps!.walletApi!;
    const delivery = this.delivery!;
    const provider = this.getActiveTokenStorageProvider();
    if (!provider) throw new SphereError('No token storage provider for intent resume', 'STORAGE_ERROR');

    const serverApply = delivery.custody === 'inventory';
    const recipientChainPubkey = hexToBytes(payload.recipient);
    const memoData =
      parseInvoiceMemoForOnChain(payload.memo, payload.invoiceRefundAddress, payload.invoiceContact) ??
      undefined;

    const deliverBlob = async (tokenBlobHex: string, opIndex: number): Promise<void> => {
      await this.savePendingV2Delivery({
        transferId,
        recipientPubkey: payload.recipient,
        tokenBlob: tokenBlobHex,
        memo: payload.memo,
        opIndex,
        createdAt: Date.now(),
      });
      const nm = this.currentNametagName();
      // §3.1 (#621): non-fatal — a recipient-side/transient delivery failure must NOT throw out of
      // resume (applyDelta below must still reconcile the server); the blob stays journaled for replay.
      await this.tryDeliver(
        () => delivery.deliver(payload.recipient, hexToBytes(tokenBlobHex), {
          transferId,
          memo: payload.memo,
          ...(nm !== undefined ? { senderNametag: nm } : {}),
        }),
        tokenBlobHex,
      );
    };

    // #621: re-deliver, never re-certify. A journaled blob for (transferId, opIndex) means the op
    // already certified in the original send (the intent stayed open on a LATER failure, e.g. applyDelta).
    // Re-running engine.transfer on the now-spent source would raise TransferConflictError — re-deliver
    // the stored blob instead (idempotent). Only run the engine op when nothing was journaled for it.
    const journaled = await this.journaledByOp(transferId);
    const spent: string[] = [];
    for (const [opIndex, genesisId] of payload.direct.entries()) {
      const existing = journaled.get(opIndex);
      if (existing) {
        await deliverBlob(existing.tokenBlob, opIndex);
      } else {
        try {
          const blob = await provider.getToken(genesisId);
          const source = await engine.decodeToken(blob);
          const finished = await engine.transfer(
            { token: source, recipientPubkey: recipientChainPubkey, data: memoData },
            // (transferId, opIndex) pairing replayed from the intent's persisted order (§8.1)
            { signal: timeoutSignal(SEND_ENGINE_OP_TIMEOUT_MS), transferId, opIndex }
          );
          await deliverBlob(bytesToHex(encodeTokenBlob(engine.encodeToken(finished))), opIndex);
        } catch (err) {
          // #621: no journaled blob, but the source is already spent on-chain — the original send
          // certified (and delivered) this op and only failed to close on a LATER step. Record the
          // spend (applyDelta below) instead of wedging on a re-certification TransferConflictError.
          if (!(err instanceof TransferConflictError)) throw err;
          logger.warn('Payments', `Resume op ${opIndex} already certified (source spent) — recording the spend, not re-certifying (§3.1):`, err);
        }
      }
      spent.push(genesisId);
    }

    let changeOutput: SphereToken | null = null;
    if (payload.split) {
      // Split opIndex follows the direct ops — replayed from the intent's order (§8.1).
      const splitOpIndex = payload.direct.length;
      const existingSplit = journaled.get(splitOpIndex);
      if (existingSplit) {
        // #621/#622-review: the split already certified in the original send — re-deliver the journaled
        // recipient blob, never re-run engine.split on the spent source (it would TransferConflictError
        // and wedge). The change output is handled by the conflict path below / a resync.
        await deliverBlob(existingSplit.tokenBlob, splitOpIndex);
      } else {
        try {
          const blob = await provider.getToken(payload.split.tokenId);
          const source = await engine.decodeToken(blob);
          const selfChainPubkey = hexToBytes(this.deps!.identity.chainPubkey);
          const { outputs } = await engine.split(
            {
              token: source,
              outputs: [
                {
                  recipientPubkey: recipientChainPubkey,
                  coinId: payload.coinId,
                  amount: BigInt(payload.split.splitAmount),
                  data: memoData,
                },
                {
                  recipientPubkey: selfChainPubkey,
                  coinId: payload.coinId,
                  amount: BigInt(payload.split.remainderAmount),
                },
              ],
            },
            { signal: timeoutSignal(SEND_ENGINE_OP_TIMEOUT_MS), transferId, opIndex: splitOpIndex }
          );
          changeOutput = outputs[1];
          // critical (#515 F2): own-storage custody — persist-or-stay-open; a
          // throw keeps the intent open and the next sign-in re-runs it.
          if (!serverApply) await this.storeEngineToken(engine, changeOutput, { criticalSave: true });
          await deliverBlob(bytesToHex(encodeTokenBlob(engine.encodeToken(outputs[0]))), splitOpIndex);
        } catch (err) {
          // #622-review: mirror the direct-op path for split. The split source is already spent on-chain
          // (a crash certified it before this resume) — record the spend instead of wedging on the
          // re-certification conflict. KNOWN LIMITATION: the change output is NOT journaled and cannot be
          // re-derived here (re-running engine.split conflicts), so a split that crashed between
          // certification and applyDelta recovers its change token via a full inventory resync. Surfaced
          // (inventory:conflict prompts that refresh) — never silently lost.
          if (!(err instanceof TransferConflictError)) throw err;
          logger.warn('Payments', `Resume split op already certified — recording the spend; change token (if any) recovers on the next inventory resync (§3.1):`, err);
          this.deps!.emitEvent('inventory:conflict', { transferId, coinId: payload.coinId, error: err.message });
        }
      }
      spent.push(payload.split.tokenId);
    }

    if (serverApply) {
      const added: { tokenId: string; key: string }[] = [];
      if (changeOutput) {
        const changeBytes = encodeTokenBlob(engine.encodeToken(changeOutput));
        added.push({ tokenId: engine.tokenId(changeOutput), key: await this.uploadOutputBlob(changeBytes) });
      }
      await provider.applyDelta(transferId, spent, added);
      if (changeOutput) await this.storeEngineToken(engine, changeOutput);
    }

    // Drop any local records of the consumed sources (present when resuming
    // on the originating device).
    for (const genesisId of spent) {
      const local = this.tokens.get(`v2_${genesisId}`);
      if (local) await this.removeToken(local.id, transferId);
    }

    // E.3 uniform close (idempotent; the apply above usually already did it).
    await walletApi.completeIntent(transferId);

    // §10: the SENT record — same dedupKey as the original attempt, so a
    // resume after the history POST is a no-op server-side.
    await this.addToHistory({
      type: 'SENT',
      amount: payload.amount,
      coinId: payload.coinId,
      symbol: this.getCoinSymbol(payload.coinId),
      timestamp: Date.now(),
      recipientPubkey: payload.recipient,
      memo: payload.memo,
      transferId,
      tokenId: payload.direct[0] ? `v2_${payload.direct[0]}` : undefined,
    });
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
   * Persist the token state to every (non-disabled) token storage provider.
   *
   * #515 D3b/F2: `SaveResult.success` is CHECKED for the ACTIVE custody
   * provider (the thin wallet-api provider deliberately returns
   * `{success:false}` on failure instead of throwing) — silent acceptance let
   * a mint certify on-chain with the blob in RAM only. On an active-provider
   * failure:
   *  - `critical: true` (user-facing mint/send paths) → throws STORAGE_ERROR,
   *    so the flow reports failure instead of success;
   *  - otherwise (background writers) → emits `storage:degraded`.
   * Non-active (secondary) provider failures keep the existing log-only
   * behavior.
   */
  private async save(opts: { critical?: boolean } = {}): Promise<void> {
    // Save to TokenStorageProviders (IndexedDB/files)
    const providers = this.getTokenStorageProviders();
    // Debug: log token serialization status
    const tokenStats = Array.from(this.tokens.values()).map(t => {
      const txf = tokenToTxf(t);
      return `${t.id.slice(0, 12)}(${t.status},txf=${!!txf})`;
    });
    logger.debug('Payments', `save(): providers=${providers.size}, tokens=[${tokenStats.join(', ')}]`);

    if (providers.size === 0) {
      logger.debug('Payments', 'save(): No token storage providers - TXF not persisted');
      return;
    }
    const data = await this.createStorageData();
    const dataKeys = Object.keys(data).filter(k => k.startsWith('token-'));
    logger.debug('Payments', `save(): TXF keys=${dataKeys.length} (${dataKeys.join(', ')})`);
    const activeId = providers.keys().next().value;
    for (const [id, provider] of providers) {
      let error: string | null = null;
      try {
        const result = await provider.save(data);
        if (!result.success) error = result.error ?? 'save failed';
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      if (error === null) continue;
      logger.error('Payments', `Failed to save to provider ${id}: ${error}`);
      if (id !== activeId) continue;
      if (opts.critical) {
        throw new SphereError(`Token storage save failed (${id}): ${error}`, 'STORAGE_ERROR');
      }
      this.deps!.emitEvent('storage:degraded', { providerId: id, error });
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

  /**
   * #621: journaled finished blobs for an intent, keyed by op position. opIndex when present,
   * else positional among the intent's entries (legacy entries journaled in op order). Resume
   * uses this to re-deliver an already-certified op instead of re-running the engine on its spent source.
   */
  private async journaledByOp(transferId: string): Promise<Map<number, PendingV2Delivery>> {
    const mine = (await this.loadPendingV2Deliveries()).filter((e) => e.transferId === transferId);
    const byOp = new Map<number, PendingV2Delivery>();
    mine.forEach((e, i) => byOp.set(e.opIndex ?? i, e));
    return byOp;
  }

  /** #517: run a journal read-modify-write atomically against all other journal mutations. */
  private withJournalLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.journalMutation.then(fn, fn);
    this.journalMutation = run.then(() => undefined, () => undefined);
    return run;
  }

  private async savePendingV2Delivery(entry: PendingV2Delivery): Promise<void> {
    await this.withJournalLock(async () => {
      const all = await this.loadPendingV2Deliveries();
      if (!all.some((e) => e.tokenBlob === entry.tokenBlob)) {
        all.push(entry);
        await this.deps!.storage.set(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES, JSON.stringify(all));
      }
    });
  }

  private async removePendingV2Delivery(tokenBlob: string): Promise<void> {
    await this.withJournalLock(async () => {
      const all = await this.loadPendingV2Deliveries();
      const filtered = all.filter((e) => e.tokenBlob !== tokenBlob);
      if (filtered.length !== all.length) {
        await this.deps!.storage.set(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES, JSON.stringify(filtered));
      }
    });
  }

  /**
   * Covenant §3.1 (#621): once the source is certified on-chain, a delivery failure must NEVER
   * fail the sender. Recipient-side conditions (a full mailbox / 429 from a never-claiming recipient)
   * and transient delivery-infra failures (5xx/network) both leave the finished blob JOURNALED for
   * (re-)delivery — the send resolves as delivery-pending and the sender moves on. The blob is already
   * journaled (savePendingV2Delivery ran before this); on success we clear the journal, on any failure
   * we keep it. Returns true if delivered, false if deferred. Never throws.
   */
  private async tryDeliver(deliver: () => Promise<unknown>, tokenBlob: string): Promise<boolean> {
    try {
      await deliver();
    } catch (err) {
      logger.warn('Payments', 'Delivery deferred (kept journaled); sender not failed (§3.1):', err);
      return false;
    }
    // Delivered. Clearing the journal is best-effort — a failure here is harmless (the idempotent
    // replay re-removes it) and must NOT flip the result to delivery-pending (#622 review).
    try {
      await this.removePendingV2Delivery(tokenBlob);
    } catch (err) {
      logger.warn('Payments', 'Delivered, but journal cleanup failed (replay will re-remove):', err);
    }
    return true;
  }

  /**
   * Replay journaled finished-but-undelivered v2 blobs (kicked from load())
   * through the delivery port (sdk-changes S3). Idempotent end to end: the
   * mailbox deposit is idempotent by the content-derived entry_id — it succeeds
   * even after the recipient claimed (§6) — and the relay path's recipient
   * dedups by the genesis-stable token id.
   *
   * #517 item 1: instead of a silent unbounded fire-and-forget, each entry is
   * retried with bounded exponential backoff, its cumulative failed-attempt
   * count is journaled across loads, and an entry that exhausts
   * {@link MAX_DELIVERY_REPLAY_ATTEMPTS} is SURFACED as poison
   * (`delivery:undeliverable`) and left journaled but no longer auto-retried —
   * so a journaled blob never sits undelivered invisibly.
   */
  private async replayPendingV2Deliveries(): Promise<void> {
    // #517: drop an overlapping pass — a replay started while one is in flight
    // would read the same journal snapshot, re-deliver the same entries, and
    // race the per-entry `attempts` read/modify/write. Dropped entries stay
    // journaled and replay on the next load(), so nothing is lost.
    if (this.replayInFlight) return;
    this.replayInFlight = true;
    try {
      // #621: skip poison and recipient-quota entries still inside their deferral window.
      const now = Date.now();
      const entries = (await this.loadPendingV2Deliveries()).filter(
        (e) => !e.undeliverable && (e.deferredUntil === undefined || e.deferredUntil <= now),
      );
      if (entries.length === 0) return;
      logger.warn('Payments', `${entries.length} undelivered v2 transfer(s) journaled from a previous session — replaying`);
      for (const e of entries) {
        await this.replayOneDelivery(e);
      }
    } finally {
      this.replayInFlight = false;
    }
  }

  /** Replay a single journaled entry: backoff retries → success/removal, or → bounded poison. */
  private async replayOneDelivery(entry: PendingV2Delivery): Promise<void> {
    const tag = entry.transferId.slice(0, 8);
    try {
      await this.attemptDeliveryWithBackoff(entry);
      await this.removePendingV2Delivery(entry.tokenBlob);
      logger.debug('Payments', `Replayed undelivered v2 transfer ${tag}...`);
    } catch (err) {
      // §3.1 (#621): a recipient-side 429 (full mailbox / never-claimer) is NOT poison — it
      // self-heals when the recipient drains. Defer it (kept journaled, never consumes the case-A
      // poison budget, retried after the deferral window), distinct from a genuine delivery failure.
      if (err instanceof WalletApiError && err.status === 429) {
        await this.deferDelivery(entry, err.message);
        return;
      }
      const attempts = (entry.attempts ?? 0) + 1;
      const message = err instanceof Error ? err.message : String(err);
      if (attempts >= MAX_DELIVERY_REPLAY_ATTEMPTS) {
        await this.markDeliveryPoison(entry, attempts, message);
        return;
      }
      await this.bumpDeliveryAttempts(entry.tokenBlob, attempts);
      logger.warn('Payments', `Replay of undelivered v2 transfer ${tag}... failed (attempt ${attempts}/${MAX_DELIVERY_REPLAY_ATTEMPTS}, kept for next load):`, err);
    }
  }

  /**
   * §3.1 (#621): defer a recipient-quota (429) delivery — keep it journaled, never poison it (it
   * self-heals when the recipient claims), and retry no sooner than the deferral window. Surfaced
   * distinctly (delivery:deferred) so a UI can show "recipient's mailbox is full — will retry".
   */
  private async deferDelivery(entry: PendingV2Delivery, error: string): Promise<void> {
    const deferredUntil = Date.now() + this.deliveryDeferralMs;
    await this.updatePendingV2Delivery(entry.tokenBlob, (e) => {
      e.deferredUntil = deferredUntil;
      e.deferredReason = 'recipient-quota';
    });
    logger.warn('Payments', `Undelivered v2 transfer ${entry.transferId.slice(0, 8)}... deferred — recipient mailbox full (429); kept journaled, retried after the deferral window (§3.1):`, error);
    this.deps!.emitEvent('delivery:deferred', {
      transferId: entry.transferId,
      recipientPubkey: entry.recipientPubkey,
      reason: 'recipient-quota',
      deferredUntil,
    });
  }

  /** One delivery with in-pass exponential backoff; throws the last error if all attempts fail. */
  private async attemptDeliveryWithBackoff(entry: PendingV2Delivery): Promise<void> {
    const nm = this.currentNametagName();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= DELIVERY_REPLAY_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = Math.min(this.replayBackoffBaseMs * 2 ** (attempt - 1), DELIVERY_REPLAY_MAX_DELAY_MS);
        if (delay > 0) await sleep(delay);
      }
      try {
        await this.delivery!.deliver(entry.recipientPubkey, hexToBytes(entry.tokenBlob), {
          transferId: entry.transferId,
          memo: entry.memo,
          ...(nm !== undefined ? { senderNametag: nm } : {}),
        });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  /** Mark a journal entry poison (keep it, stop retrying) and surface it (#517 item 1). */
  private async markDeliveryPoison(entry: PendingV2Delivery, attempts: number, error: string): Promise<void> {
    await this.updatePendingV2Delivery(entry.tokenBlob, (e) => { e.attempts = attempts; e.undeliverable = true; });
    logger.error('Payments', `Undelivered v2 transfer ${entry.transferId.slice(0, 8)}... is POISON after ${attempts} attempts — surfaced, kept journaled, no longer auto-retried:`, error);
    this.deps!.emitEvent('delivery:undeliverable', {
      transferId: entry.transferId,
      recipientPubkey: entry.recipientPubkey,
      attempts,
      error,
    });
  }

  private async bumpDeliveryAttempts(tokenBlob: string, attempts: number): Promise<void> {
    await this.updatePendingV2Delivery(tokenBlob, (e) => { e.attempts = attempts; });
  }

  /** Mutate one journaled entry in place (keyed by tokenBlob) and persist. No-op if gone. */
  private async updatePendingV2Delivery(tokenBlob: string, mutate: (e: PendingV2Delivery) => void): Promise<void> {
    await this.withJournalLock(async () => {
      const all = await this.loadPendingV2Deliveries();
      const target = all.find((e) => e.tokenBlob === tokenBlob);
      if (!target) return;
      mutate(target);
      await this.deps!.storage.set(STORAGE_KEYS_ADDRESS.PENDING_V2_DELIVERIES, JSON.stringify(all));
    });
  }

  private async createStorageData(): Promise<TxfStorageDataBase> {
    const sorted = [...this._historyCache].sort((a, b) => b.timestamp - a.timestamp);
    return await buildTxfStorageData(
      Array.from(this.tokens.values()),
      {
        version: 1,
        address: this.deps!.identity.chainPubkey,
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
}

// =============================================================================
// Factory Function
// =============================================================================

export function createPaymentsModule(config?: PaymentsModuleConfig): PaymentsModule {
  return new PaymentsModule(config);
}
