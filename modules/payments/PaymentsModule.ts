/**
 * Payments Module
 * Platform-independent token operations with full wallet repository functionality
 *
 * Includes:
 * - Token CRUD operations
 * - Tombstones for sync
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
  TxfTransaction,
  TombstoneEntry,
  NametagData,
} from '../../types/txf';
import type { SplitPlan, TokenWithAmount } from './TokenSplitCalculator';
import type { ITokenEngine, SphereToken } from '../../token-engine';
import {
  CheckpointTrustbaseMismatchError,
  type SplitCheckpointStore,
  SplitCheckpointLostError,
  TransferConflictError,
} from '../../token-engine';
import { WalletApiCheckpointStore } from '../../impl/shared/wallet-api/WalletApiCheckpointStore';
import { WalletApiError } from '../../wallet-api';
import type { V2TransferPayload } from '../../types/v2-transfer';
import { TokenReservationLedger } from './TokenReservationLedger';
import {
  MAX_SEND_OPERATION_CONCURRENCY,
  isKeepOpenSendError,
  summarizeOutcomes,
  type OperationOutcome,
  type SendOperation,
  type SendOutcomeSummary,
} from './SendOperations';
import { SpendPlanner, SpendQueue, type ParsedTokenEntry } from './SpendQueue';
import { PaymentRequests, type PaymentRequestsHost } from './requests/PaymentRequests';
import { TransferHistory, type TransferHistoryHost } from './history/TransferHistory';
import { IntentResume, type IntentResumeHost } from './resume/IntentResume';
import { Delivery, type DeliveryHost, type ReceiveOptions, type ReceiveResult } from './receive/Delivery';
import {
  TokenView,
  type TokenViewHost,
  createTokenStateKey,
  extractStateHashFromSdkData,
  extractTokenIdFromSdkData,
  extractTokenStateKey,
  looksLikeTokenBlob,
} from './inventory/TokenView';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../storage';
import type {
  TransportProvider,
  PeerInfo,
  IncomingTokenTransfer,
} from '../../transport';
import type { DeliveryProvider, IncomingDelivery, WakeStream } from '../../transport/delivery-provider';
import { deriveFieldEncryptionKey, encryptField } from '../../core/field-encryption';
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
import {
  buildTxfStorageData,
  parseTxfStorageData,
} from '../../serialization/txf-serializer';
import { TokenRegistry } from '../../registry';
import { logger } from '../../core/logger';
import { SphereError, PartialSendConflictError, isPossiblyCommittedSendOutcome } from '../../core/errors';
import { sha256, bytesToHex, hexToBytes } from '../../core/crypto';
import { PumpHealth } from './pump-health';
import { timeoutSignal } from '../../core/timeout';
import { randomUUID } from '../../core/uuid';
import { decodeTokenBlob, encodeTokenBlob, unwrapTokenBlobBytes } from '../../token-engine/token-blob';

// =============================================================================
// Transaction History Entry
// =============================================================================

/**
 * Public history entry type — re-exported from the shared storage layer.
 * Single source of truth: {@link HistoryRecord} in `storage/storage-provider.ts`.
 */
export type TransactionHistoryEntry = import('../../storage').HistoryRecord;

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
 * Incoming-delivery poll interval (sdk-changes S3). The pull is the
 * correctness path; the optional wake hook only shortens latency (§9 — a
 * dropped wake can never cause divergence).
 */
const DELIVERY_POLL_INTERVAL_MS = 30_000;

/** #623: incoming claim/reject are submitted in batches of this size (one request each) so a large
 * inbox drain doesn't fire one write per entry and trip the per-owner rate limit. */
const INCOMING_ACK_BATCH_SIZE = 200;
/** #625: max times send() re-plans after demoting an already-spent source (self-healing selection).
 * A backstop — each retry permanently demotes one stale source, so convergence is fast. */
const MAX_RESELECT_ATTEMPTS = 8;

/**
 * The ONE error a failed fan-out surfaces, prepared for the caller.
 *
 * #625: tags the conflict for self-healing only when nothing certified in this
 * attempt (decided from the complete settled set, never mid-flight), and logs
 * every settled failure — a parallel batch can fail several independent ways,
 * and dropping the rest hides them from apps and bug reports. The non-surfaced
 * ones ride along as `suppressedErrors`: visibility only, never dispositive.
 */
function surfacedSendFailure(summary: SendOutcomeSummary): unknown {
  const primaryError = summary.primaryError;
  if (summary.conflictTagSourceId !== undefined && primaryError instanceof TransferConflictError) {
    primaryError.conflictedSourceId = summary.conflictTagSourceId;
  }
  for (const f of summary.failures) {
    logger.warn(
      'Payments',
      `Send op ${f.op.opIndex} (${f.op.kind}) failed${f.certified ? ' AFTER on-chain certification' : ''}:`,
      f.error,
    );
  }
  const suppressed = summary.failures.map((f) => f.error).filter((e) => e !== primaryError);
  if (suppressed.length > 0 && primaryError instanceof Error) {
    (primaryError as Error & { suppressedErrors?: unknown[] }).suppressedErrors = suppressed;
  }
  return primaryError;
}

/**
 * What one send attempt learned about itself, as it progresses. The failure
 * disposition reads it to tell the three non-plain outcomes apart: a rejected
 * intent (#670 — no server row to abort), a post-commit mirror lag (#665 —
 * SEND_SYNC_PENDING), and the settled committed accounting (#677 remainder).
 */
interface SendAttemptState {
  /** Settled fan-out accounting; undefined when the failure preceded every engine op. */
  summary?: SendOutcomeSummary;
  /** §3.1 (#621): a leg's post-certification delivery was deferred (blob kept journaled). */
  deliveryPending: boolean;
  /** Every submit certified and the server-mirror persistence has begun (inventory custody only). */
  onChainCommitComplete: boolean;
  /** The intent PUT was deterministically rejected — the local copy is already dropped. */
  intentRejected: boolean;
}

/** Everything one send's engine operations need, fixed for the whole fan-out. */
export interface CertifyContext {
  readonly engine: ITokenEngine;
  /** The intent id — half of the (transferId, opIndex) realization seed (§8.1). */
  readonly transferId: string;
  readonly recipientChainPubkey: Uint8Array;
  readonly recipientChainPubkeyHex: string;
  readonly selfChainPubkey: Uint8Array;
  readonly coinId: string;
  readonly memo?: string;
  /** E.4 burn checkpoint for the split leg; absent when no store is configured. */
  readonly checkpointStore?: SplitCheckpointStore;
}

/** The genesis-stable id of a held token — identical across every state (§8.1). */
function genesisIdOf(token: Token): string {
  return extractTokenIdFromSdkData(token.sdkData) ?? token.id.replace(/^v2_/, '');
}

/**
 * The send's on-chain operations in plan order: the direct transfers, then the
 * at-most-one split. ONE realization seed per send (ARCHITECTURE §7/§8.1) —
 * the intent transferId plus this plan-derived opIndex seed every engine op, so
 * any device holding the wallet seed rebuilds the identical transactions and
 * resume recovers per-op by journal presence, whatever the execution order was.
 */
function buildSendOperations(splitPlan: SplitPlan): SendOperation[] {
  const operations: SendOperation[] = splitPlan.tokensToTransferDirectly.map((tw, opIndex) => ({
    kind: 'direct' as const,
    opIndex,
    uiTokenId: tw.uiToken.id,
    genesisId: genesisIdOf(tw.uiToken),
    sourceSdkData: tw.uiToken.sdkData ?? '',
    sdkToken: tw.sdkToken as SphereToken,
    deliveredAmount: tw.amount, // #677: a direct op delivers its whole amount
  }));
  if (splitPlan.requiresSplit && splitPlan.tokenToSplit) {
    const { splitAmount, remainderAmount } = splitPlan;
    if (splitAmount === null || remainderAmount === null) {
      // Planner invariant (SpendQueue.calculateOptimalSplitSync): requiresSplit
      // implies both amounts. Defaulting a null to 0n would silently construct a
      // 0-value split — fail loudly; no engine op has run, nothing is on-chain.
      throw new SphereError(
        'Split plan invariant violated: requiresSplit with null splitAmount/remainderAmount',
        'TRANSFER_FAILED'
      );
    }
    operations.push({
      kind: 'split',
      opIndex: operations.length,
      uiTokenId: splitPlan.tokenToSplit.uiToken.id,
      genesisId: genesisIdOf(splitPlan.tokenToSplit.uiToken),
      sourceSdkData: splitPlan.tokenToSplit.uiToken.sdkData ?? '',
      sdkToken: splitPlan.tokenToSplit.sdkToken as SphereToken,
      deliveredAmount: splitAmount, // #677: a split op delivers only splitAmount
      remainderAmount,
    });
  }
  return operations;
}

/**
 * The app-facing form of a deterministic intent rejection (a raw WalletApiError
 * is not a SphereError, so it would reach callers untyped).
 */
function intentValidationError(err: WalletApiError): SphereError {
  return new SphereError(
    // Matches the server's "envelope exceeds N bytes (§8.3)" and the SDK
    // checker's "exceeds size cap of N bytes".
    /exceeds .*bytes/.test(err.message)
      ? "The payment could not be registered with the wallet service because it exceeds the service's size limit. Try sending a smaller amount."
      : 'The wallet service rejected this payment as invalid.',
    'VALIDATION_ERROR',
    err
  );
}

/** A {@link TransferResult} under construction — sealed by the time it is returned. */
type MutableTransferResult = { -readonly [K in keyof TransferResult]: TransferResult[K] };

/**
 * Receive + delivery types live with the feature ({@link Delivery}); re-exported
 * here so the module's public surface (and `modules/payments/index.ts`) is
 * unchanged.
 */
export type { PendingV2Delivery, ReceiveOptions, ReceiveResult } from './receive/Delivery';

/**
 * Token-key derivation moved with the inventory view ({@link TokenView});
 * re-exported here so the module's public surface (and
 * `modules/payments/index.ts`) is unchanged.
 */
export {
  createTokenStateKey,
  extractStateHashFromSdkData,
  extractTokenIdFromSdkData,
  extractTokenStateKey,
} from './inventory/TokenView';

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
    }
  }

  // v2-only: anything that is not an engine blob is a stored v1 TXF relic. The
  // v1 JSON display parser was removed with the rest of the v1 stack, so such a
  // token reports as UNKNOWN rather than being decoded by a format we no longer
  // support.
  return defaultInfo;
}

// =============================================================================
// Repository Utility Functions
// =============================================================================

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
  /**
   * E.3: persist the client-encrypted intent; MUST be awaited before the engine. `requiresSeedClose`
   * (E.4/#87) marks a split intent whose terminal close is seed-gated — set BEFORE the burn.
   */
  putIntent(transferId: string, payloadEnvelope: string, opts?: { requiresSeedClose?: boolean }): Promise<void>;
  /** E.3 uniform close — every finished send ends with this (idempotent; signs the §87 close). */
  completeIntent(transferId: string): Promise<void>;
  /** E.2 lost-race cleanup (soft, recoverable). */
  abortIntent(transferId: string): Promise<void>;
  /**
   * #670: drop the local intent backstop copy — OPTIONAL capability, called only when the intent
   * PUT was deterministically rejected (422 VALIDATION) with nothing on-chain, so keeping the copy
   * would poison the resync replay forever. A port without a local copy has nothing to drop.
   */
  removeLocalIntent?(transferId: string): Promise<void>;
  /**
   * E.4 burn checkpoint (sphere-sdk#501) — OPTIONAL capability. When present (the WalletApiClient
   * provides them), a split's resume is checkpoint-protected via {@link WalletApiCheckpointStore};
   * a composed port without them keeps today's residual (a split resumed after a certified mint
   * cannot recover its change — surfaced via inventory resync).
   */
  postIntentProgress?(transferId: string, opIndex: number, payloadEnvelope: string): Promise<string>;
  getIntentProgress?(transferId: string): Promise<readonly { opIndex: number; payload: string }[]>;
  /** E.3 resume: list open intents at sign-in (any device). */
  listIntents(status: 'open' | 'aborted'): Promise<
    { transferId: string; payload: string; status: 'open' | 'completed' | 'aborted'; createdAt: number }[]
  >;
  /**
   * #676: read the LOCAL intent dispositions (status + the #516 `abortPending`
   * flag) for EVERY known intent in ONE pass, keyed by transferId — OPTIONAL
   * capability. Resume reads this ONCE before its loop and consults it per
   * server-`open` intent: a locally-`aborted` (or abort-pending) copy is a send
   * the user already watched fail whose soft-abort never reached the server, so
   * re-executing it would double-pay. A transferId ABSENT from the map (or a port
   * that omits this method) leaves the server copy authoritative — correct for a
   * fresh device. Batched (PR #681 review): the per-intent read re-parsed the
   * whole intents blob N times; this parses it once.
   */
  getLocalIntentsMap?(): Promise<
    Map<string, { status: 'open' | 'completed' | 'aborted'; abortPending: boolean }>
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
 * The decrypted E.3 intent payload (`{ sources, recipient, amounts }` concretized).
 * `v:2` (E.4, sphere-sdk#501) is the only shape: a split resumes from its durable
 * burn checkpoint.
 */
export interface IntentPayloadV1 {
  v: 2;
  /** Recipient chain pubkey (33-byte compressed, hex). */
  recipient: string;
  coinId: string;
  /** Requested amount (decimal string). */
  amount: string;
  memo?: string;
  /** Genesis token ids transferred whole, in execution order. */
  direct: string[];
  /** The at-most-one split (ARCHITECTURE §7). */
  split?: { tokenId: string; splitAmount: string; remainderAmount: string };
  /**
   * M7: the state each consumed source was SPENT at, keyed by genesis token id, so an
   * interrupted-send resume is STATE-AWARE without re-reading a live view a concurrent
   * claim may have advanced. `local` = sha256-over-bytes (for removeToken's keep-guard);
   * `protocol` = the deliveryKeys imprint = the server state_hash (for the spend's
   * knownSpends record). Absent on legacy (pre-M7) payloads — resume then falls back to
   * the fail-closed path (no state-aware keep, no composite knownSpends).
   */
  spentStates?: Record<string, { local: string; protocol: string }>;
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
   * Delivery port (sdk-changes S7). Asset transfers ride it exclusively —
   * outgoing via `deliver()`, incoming via `incoming()` (poll + wake). There is
   * no fallback rail: without it send/receive fail loudly at the call site,
   * while non-payment Sphere modules keep working. Swappable by construction;
   * any implementation must pass `tests/contract/delivery-provider.contract.ts`.
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

  private nametags: NametagData[] = [];

  /** Inventory reads: balances/assets, the token accessors, tombstones, validate(). */
  private readonly inventory: TokenView;

  /** Payment requests (incoming + outgoing, the S4 pump, the #441 journal). */
  private readonly requests: PaymentRequests;

  /** Transaction history (the cache, the dedupKey rules, the §10 server log). */
  private readonly history: TransferHistory;

  /** E.3/E.4 intent resume (the sign-in replay of OPEN send intents). */
  private readonly intents: IntentResume;

  /** Receive + delivery (receive(), the v2 receiver, the journal, the replay budget). */
  private readonly deliveries: Delivery;

  // Subscriptions

  // Delivery port (sdk-changes S3/S7)
  /** The single delivery seam — an injected provider or the transport adapter. */
  private delivery: DeliveryProvider | null = null;
  /** Set only when a provider was INJECTED — gates the incoming pump (S3). */
  private deliveryWakeUnsub: (() => void) | null = null;
  private deliveryPollTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Low-frequency inventory poll (§9): the correctness backstop that converges
   * the owned-token set even when an `inventory` wake is missed. Mirrors the
   * delivery/PR pumps' interval; the wake is just a nudge that pulls sooner.
   */
  private inventoryPollTimer: ReturnType<typeof setInterval> | null = null;
  /** Coalesces concurrent incoming-pump runs. */
  /**
   * #724: load and delivery-drain MUTUAL exclusion.
   *
   * They cannot overlap in EITHER direction. A load clears the token map and
   * repopulates it from a snapshot; a drain stores tokens into that map and acks
   * them into a persistent seen-set, so an overlap in either order can erase a
   * token that can never be re-delivered. Awaiting the other side's promise at
   * entry is not enough — that only sees what is in flight at that instant, and
   * the wake ordering starts the drain first with the load 500ms behind it.
   *
   * A single tail-chained mutex, so the answer to "may I touch the token map"
   * is one variable rather than four observed at four different moments.
   */
  private tokenMapMutex: Promise<unknown> = Promise.resolve();

  private pumpInFlight: Promise<number> | null = null;
  /** S6 field-encryption key (intent payloads, history memos) — per identity. */
  private fieldEncryptionKey: Uint8Array | null = null;
  private checkpointStore: SplitCheckpointStore | null = null;

  // Guard: ensure load() completes before processing incoming bundles
  private loadedPromise: Promise<void> | null = null;

  /**
   * #642 single-flight guard for {@link load}: the in-flight load, the owner
   * (chainPubkey) it runs for, and whether a coalesced caller asked for one
   * trailing re-run once it completes. The 30s inventory poll backstop and the
   * `inventory` wakes both funnel into load() via {@link resyncInventory}; on a
   * heavy wallet one load can outlive the poll interval, and uncoalesced calls
   * would stack concurrent full loads — each with its own history hydration.
   * The re-run is scheduled on a tracked macrotask (`loadRerunTimer`) so
   * destroy()/re-init can cancel it even after the flag was consumed.
   */
  private loadInFlight: Promise<void> | null = null;
  private loadInFlightOwner: string | null = null;
  private loadRerunRequested = false;
  private loadRerunTimer: ReturnType<typeof setTimeout> | null = null;

  // Storage event subscriptions (push-based sync)
  private inventoryDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SYNC_DEBOUNCE_MS = 500;
  /** Quiet-then-escalate logging for the background wallet-api pumps (#630). */
  private readonly pumpHealth = new PumpHealth();

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

    // Initialize spend queue (requires ledger, planner, and access to this.tokens)
    this.spendQueue = new SpendQueue(
      this.reservationLedger,
      this.spendPlanner,
      () => this.tokens,
      this.parsedTokenCache
    );

    this.inventory = new TokenView(this.tokenViewHost());
    this.requests = new PaymentRequests(this.paymentRequestsHost());
    this.history = new TransferHistory(this.transferHistoryHost());
    this.intents = new IntentResume(this.intentResumeHost());
    this.deliveries = new Delivery(this.deliveryHost());
  }

  /**
   * The narrow seam {@link TokenView} reaches back through. Live getters for
   * `deps` and `priceProvider` (both swapped on {@link initialize}); the token
   * map is handed over as a READ-ONLY view, so the inventory view never becomes
   * a second writer of it.
   */
  private tokenViewHost(): TokenViewHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const module = this;
    return {
      get deps() { return module.deps; },
      get priceProvider() { return module.priceProvider; },
      ensureInitialized: () => this.ensureInitialized(),
      getHeldTokens: () => this.tokens,
      isPriceDisabled: () => this.isPriceDisabled(),
      deleteParsedToken: (tokenId) => { this.parsedTokenCache.delete(tokenId); },
      save: () => this.save(),
    };
  }

  /**
   * The narrow seam {@link Delivery} reaches back through. Live getters for
   * `deps` and `delivery` (both swapped on every {@link initialize}); the token
   * map is handed over as a READ-ONLY view and written only by the module's own
   * `storeEngineToken`, so delivery never becomes a second writer.
   */
  private deliveryHost(): DeliveryHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const module = this;
    return {
      get deps() { return module.deps; },
      get delivery() { return module.delivery; },
      get loadedPromise() { return module.loadedPromise; },
      ensureInitialized: () => this.ensureInitialized(),
      ensureDelivery: () => this.ensureDelivery(),
      currentNametagName: () => this.currentNametagName(),
      getHeldTokens: () => this.tokens,
      pumpIncomingDeliveriesFresh: () => this.pumpIncomingDeliveriesFresh(),
      storeEngineToken: (engine, token, opts) => this.storeEngineToken(engine, token, opts),
      addToHistory: (entry) => this.addToHistory(entry),
    };
  }

  /**
   * The narrow seam {@link PaymentRequests} reaches back through. Live getters,
   * not a snapshot: `deps` is swapped on every {@link initialize} (address
   * switch) and the feature must always observe the CURRENT one.
   */
  private paymentRequestsHost(): PaymentRequestsHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const module = this;
    return {
      get deps() { return module.deps; },
      get pumpHealth() { return module.pumpHealth; },
      get pollIntervalMs() { return DELIVERY_POLL_INTERVAL_MS; },
      get loadedPromise() { return module.loadedPromise; },
      ensureInitialized: () => this.ensureInitialized(),
      currentNametagName: () => this.currentNametagName(),
      send: (request) => this.send(request),
    };
  }

  /**
   * The narrow seam {@link TransferHistory} reaches back through. Live getter
   * for `deps` (swapped on every {@link initialize}); the rest are thunks onto
   * the module's own private helpers — history never touches the token map or
   * `save()`.
   */
  private transferHistoryHost(): TransferHistoryHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const module = this;
    return {
      get deps() { return module.deps; },
      ensureInitialized: () => this.ensureInitialized(),
      getLocalTokenStorageProvider: () => this.getLocalTokenStorageProvider(),
      getFieldEncryptionKey: () => this.getFieldEncryptionKey(),
      getCoinSymbol: (coinId) => this.getCoinSymbol(coinId),
    };
  }

  /**
   * The narrow seam {@link IntentResume} reaches back through. Live getters for
   * `deps` and `delivery` (both swapped on every {@link initialize}); the rest
   * are thunks onto the module's own helpers. The token map is READ through
   * `getHeldToken` and written only by the module's `removeToken` /
   * `storeEngineToken` — resume never becomes a second writer.
   */
  private intentResumeHost(): IntentResumeHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const module = this;
    return {
      get deps() { return module.deps; },
      get delivery() { return module.delivery; },
      get loadedPromise() { return module.loadedPromise; },
      ensureInitialized: () => this.ensureInitialized(),
      getFieldEncryptionKey: () => this.getFieldEncryptionKey(),
      getActiveTokenStorageProvider: () => this.getActiveTokenStorageProvider(),
      getCheckpointStore: () => this.getCheckpointStore(),
      certifyOperation: (op, ctx) => this.certifyOperation(op, ctx),
      deliverCommittedBlobs: (blobs, recipientPubkey, transferId, memo) =>
        this.deliveries.deliverCommittedBlobs(blobs, recipientPubkey, transferId, memo),
      applyInventoryDelta: (engine, transferId, spentStates, changeOutput, storage) =>
        this.applyInventoryDelta(engine, transferId, spentStates, changeOutput, storage),
      storeEngineToken: (engine, token, opts) => this.storeEngineToken(engine, token, opts),
      getHeldToken: (id) => this.tokens.get(id),
      removeToken: (tokenId, excludeReservationId, expectedStateHash) =>
        this.removeToken(tokenId, excludeReservationId, expectedStateHash),
      loadPendingV2Deliveries: () => this.deliveries.loadPendingV2Deliveries(),
      addToHistory: (entry) => this.addToHistory(entry),
      getCoinSymbol: (coinId) => this.getCoinSymbol(coinId),
      reconcileSettlingPaymentRequests: (outcome, openIntentIds, localIntents, localReadFailed) =>
        this.requests.reconcileSettlingPaymentRequests(outcome, openIntentIds, localIntents, localReadFailed),
    };
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
   * Swap the live token engine WITHOUT re-initializing the module — used by
   * `Sphere.setOracleApiKey()` after it rebuilds the engine with a new gateway
   * key. Operations snapshot `this.deps.tokenEngine` into a local at their start
   * (see send/mint/split), so an in-flight op finishes on the PREVIOUS engine
   * (submit + proof stay paired); only ops started after this use the new one.
   */
  setTokenEngine(engine?: ITokenEngine): void {
    if (this.deps) this.deps.tokenEngine = engine;
    this.spendPlanner.setEngine(engine);
  }

  /**
   * Initialize module with dependencies
   */
  initialize(deps: PaymentsModuleDependencies): void {
    // #515 F1: refuse illegal custody compositions BEFORE any state is touched.
    assertLegalCustodyComposition(deps);

    // Clean up previous subscriptions before re-initializing
    this.teardownDeliveryPump();
    this.requests.teardownPaymentRequestPump();

    // Stop background subscriptions from the previous address context so they
    // don't call save() in the new address's storage context.

    // Cancel pending payment response resolvers
    this.requests.cancelPendingResponseResolvers('Address switched');

    // Reset per-address state (will be re-populated by load())
    this.tokens.clear();
    this.inventory.initialize();
    this.history.initialize();
    this.loadRerunRequested = false;
    if (this.loadRerunTimer !== null) {
      clearTimeout(this.loadRerunTimer);
      this.loadRerunTimer = null;
    }
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
    this.checkpointStore = null; // rebuilt lazily — it captures the per-identity field key (E.4)
    // Path B: wire the engine into the planner (value reads use it when present).
    this.spendPlanner.setEngine(deps.tokenEngine);

    const lazyDeliveryKeys = async (blobBytes: Uint8Array): Promise<{ tokenId: string; stateHash: string }> => {
      const engine = this.deps?.tokenEngine;
      if (!engine) throw new SphereError('Token engine required for delivery-key derivation (S7)', 'AGGREGATOR_ERROR');
      return engine.deliveryKeys(blobBytes);
    };
    this.delivery = deps.delivery ?? null;
    if (this.delivery) {
      // S7: the module owns the engine — late-bind the backend-true derivation
      // into whatever delivery provider was composed.
      this.delivery.bindDeliveryKeys?.(lazyDeliveryKeys);
      this.delivery.setIdentity?.({
        privateKey: deps.identity.privateKey,
        chainPubkey: deps.identity.chainPubkey,
      });

      // One wake socket multiplexes all three owner streams (§9): route each
      // nudge to its own (debounced/coalesced) pull. The wake is best-effort —
      // every stream below also has a poll backstop that is the correctness
      // path. (Before this, only `mailbox` was consumed, so a second session
      // saw no realtime inventory/payment-request convergence.)
      this.deliveryWakeUnsub =
        this.delivery.onWake?.(
          (stream) => this.handleWake(stream),
          // §9: surface TRUE wake-socket liveness, decoupled from sign-in state,
          // so the frontend can show a "live/reconnecting" indicator.
          (status) => this.deps?.emitEvent('realtime:status', { status })
        ) ?? null;
      // Poll is the correctness path; the wake is just a nudge (§9).
      this.deliveryPollTimer = setInterval(() => {
        this.pumpHealth.run('delivery', () => this.pumpIncomingDeliveries());
      }, DELIVERY_POLL_INTERVAL_MS);
      // Inventory poll backstop (§9): converges the owned-token set even if an
      // `inventory` wake is missed, mirroring the delivery/PR pumps' interval.
      // rerunOnCoalesce=false: the poll's next tick IS its retry — requesting
      // the #642 trailing re-run here would turn any load slower than the poll
      // interval into gapless back-to-back loads.
      this.inventoryPollTimer = setInterval(() => {
        this.pumpHealth.run('inventory', () => this.resyncInventory(false));
      }, DELIVERY_POLL_INTERVAL_MS);
    }

    // Payment requests ride wallet-api (sdk-changes S4) — re-armed for the new
    // identity once `deps` is in place.
    this.requests.initialize();

    // Subscribe to storage provider events (push-based sync)
  }

  /**
   * Load all token data from storage providers and restore wallet state.
   *
   * Loads tokens, nametag data, transaction history, and pending transfers
   * from configured storage providers. Restores pending V5 tokens and
   * triggers a fire-and-forget {@link resolveUnconfirmed} call.
   */
  /** Run `fn` with exclusive access to the token map (see {@link tokenMapMutex}). */
  private withTokenMap<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tokenMapMutex.then(fn, fn);
    this.tokenMapMutex = run.then(() => undefined, () => undefined);
    return run;
  }

  async load(): Promise<void> {
    return this.loadWith(true);
  }

  /**
   * #642: like {@link load}, but the caller must observe storage as of NOW —
   * it must never coalesce onto a load that began before the caller's writes
   * (the shared snapshot would omit them, and its `loadFromStorageData` would
   * drop them from the in-memory map). Serializes behind any in-flight load
   * (whose failure is not this caller's) and then runs fresh.
   */
  private async loadFresh(): Promise<void> {
    while (this.loadInFlight) {
      await this.loadInFlight.catch(() => {});
    }
    return this.loadWith(true);
  }

  /**
   * @param rerunOnCoalesce whether a call coalesced onto an in-flight load
   *   should schedule the trailing re-run. The wake path and direct callers
   *   want it (converge now, not at the next tick); the 30s poll backstop
   *   passes `false` — its next tick IS the retry, and re-running on its
   *   behalf would turn any load slower than the poll interval into gapless
   *   back-to-back loads.
   */
  private async loadWith(rerunOnCoalesce: boolean): Promise<void> {
    this.ensureInitialized();

    // #642 single-flight: coalesce same-owner callers onto the in-flight load
    // instead of stacking concurrent full loads (each with its own history
    // hydration — on a heavy wallet that is a 100-page storm per caller). A
    // coalesced call schedules exactly ONE trailing re-run, so an `inventory`
    // wake that raced a load still converges without waiting for the next
    // 30s poll tick. A DIFFERENT-owner call (re-init mid-load) serializes
    // behind the stale load and then runs fresh — its data must not come from
    // a load started for the previous address.
    const owner = this.deps!.identity.chainPubkey;
    while (this.loadInFlight) {
      if (this.loadInFlightOwner === owner) {
        if (rerunOnCoalesce) this.loadRerunRequested = true;
        return this.loadInFlight;
      }
      await this.loadInFlight.catch(() => {});
    }

    // Expose a promise that incoming transfer handlers can await to ensure
    // the token map is populated before running dedup checks.
    const doLoad = async () => {
      // Ensure token registry has loaded metadata (symbol, name, decimals)
      // before parsing tokens — otherwise tokens get fallback truncated coinId values
      await TokenRegistry.waitForReady();

      // Load metadata from TokenStorageProviders (tombstones, nametags, history)
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
              await this.history.importRemoteHistoryEntries(txfData._history as HistoryRecord[]);
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

    };

    const run = async (): Promise<void> => {
      // #724: exclusive with the delivery drain, in both directions.
      this.loadedPromise = this.withTokenMap(doLoad);
      await this.loadedPromise;

      // Replay finished-but-undelivered v2 blobs from a previous session
      // (fire-and-forget; failures are kept journaled for the next load).
      void this.deliveries.replayPendingV2Deliveries().catch((err) =>
        logger.warn('Payments', 'Pending v2 delivery replay failed:', err));

      // S3: drain the delivery port's incoming feed once at load (poll + wake
      // keep it drained afterwards).
      if (this.delivery) {
        this.pumpHealth.run('delivery', () => this.pumpIncomingDeliveries());
      }

      // S4: drain the payment-request `?since=` stream once at load (the poll
      // keeps it drained afterwards).
      if (this.requests.paymentRequestsApi()) {
        this.pumpHealth.run('payment-requests', () => this.requests.pumpPaymentRequests());
      }
    };

    this.loadInFlightOwner = owner;
    this.loadInFlight = run().finally(() => {
      this.loadInFlight = null;
      this.loadInFlightOwner = null;
      if (this.loadRerunRequested) {
        // One trailing re-run on behalf of the coalesced callers, routed
        // through resyncInventory() so the convergence it brings emits
        // `sync:remote-update` with the re-run's actual delta (a bare load()
        // would merge new tokens silently and the UI would not refresh until
        // the next poll tick). Scheduled on a TRACKED macrotask so destroy()
        // and re-init can cancel it even after the flag was consumed, and run
        // under the inventory pump health so a failure is classified
        // (quiet-then-escalate) instead of an unhandled rejection.
        //
        // rerunOnCoalesce=false: the re-run IS the convergence pass. If, when
        // its macrotask fires, another load is already in flight (e.g. a poll
        // tick started one in the gap), coalescing onto it already observes
        // the change — requesting yet another re-run would chain into gapless
        // back-to-back loads under slow-load regimes, the exact behavior the
        // poll opt-out prevents.
        this.loadRerunRequested = false;
        this.loadRerunTimer = setTimeout(() => {
          this.loadRerunTimer = null;
          this.pumpHealth.run('inventory', () => this.resyncInventory(false));
        }, 0);
      }
    });
    return this.loadInFlight;
  }

  /**
   * Cleanup all subscriptions, polling jobs, and pending resolvers.
   *
   * Should be called when the wallet is being shut down or the module is
   * no longer needed.
   */
  destroy(): void {
    // A load still in flight may finish after teardown — make sure its
    // trailing re-run (#642) does not restart work on a destroyed module,
    // whether the flag is still pending or already consumed into the timer.
    this.loadRerunRequested = false;
    if (this.loadRerunTimer !== null) {
      clearTimeout(this.loadRerunTimer);
      this.loadRerunTimer = null;
    }
    this.teardownDeliveryPump();
    this.requests.destroy();

    // Clean up spend queue and reservation ledger
    this.spendQueue.destroy();
    this.reservationLedger.clear();
    this.parsedTokenCache.clear();
    // getBalance()/getTokens()/getToken() read this map directly, so a destroyed module
    // otherwise keeps answering balance queries from a wallet that no longer exists.
    this.tokens.clear();

    // Clean up storage event subscriptions
  }

  // ===========================================================================
  // Public API - Send
  // ===========================================================================

  /**
   * Send tokens to recipient
   * Supports automatic token splitting when exact amount is needed
   *
   * @param request - Transfer request.
   */
  /**
   * #625 — self-healing coin selection. If a selected source turns out already spent on-chain
   * (`TransferConflictError`) with NOTHING certified yet, demote it (durable `suspectedSpent` — kept in
   * inventory, excluded from selection) and re-plan with the next candidate, bounded. Exhausting the
   * live candidates surfaces a clean `SEND_INSUFFICIENT_BALANCE`, never an endless loop.
   *
   * #677 — remainder re-plan. If a source is lost mid-send AFTER ≥1 leg already certified + delivered
   * (`PartialSendConflictError`), a full-amount re-plan would double-pay the delivered leg — so re-plan
   * ONLY the still-owed remainder (`X − already-delivered`) from the remaining live sources, under a
   * NEW transferId. A send for X thus still delivers X even through a mid-send conflict; the certified
   * legs converge via the recipient's §6 claim handoff. `PartialSendConflictError` reaches the CALLER
   * only as the fallback — when that remainder genuinely cannot be covered by the other sources.
   */
  async send(request: TransferRequest): Promise<TransferResult> {
    // #677: the running request shrinks to the still-owed REMAINDER across partial
    // re-plans while the recipient must ultimately receive the full original amount.
    let currentRequest = request;
    // Certified legs accumulated across partial attempts — carried into the fallback
    // so it NEVER re-sends them; the first partial intent id anchors the §6 handoff.
    const deliveredSourceIds: string[] = [];
    let primaryPartialTransferId: string | undefined;

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.sendOnce(currentRequest);
      } catch (err) {
        // #625 — self-healing full re-plan: a clean conflict with NOTHING certified
        // in that attempt (safe to re-select the whole amount from the next candidate).
        const conflictedId = err instanceof TransferConflictError ? err.conflictedSourceId : undefined;
        if (
          conflictedId !== undefined &&
          attempt < MAX_RESELECT_ATTEMPTS &&
          this.tokens.has(conflictedId)
        ) {
          await this.demoteSuspectedSpent(conflictedId);
          logger.warn(
            'Payments',
            `Source ${conflictedId} already spent on-chain — demoted, re-planning with the next candidate (#625, attempt ${attempt + 1}/${MAX_RESELECT_ATTEMPTS})`,
          );
          continue;
        }

        // #677 — a mid-send conflict AFTER ≥1 leg certified + delivered. Re-plan ONLY
        // the remainder (never the full amount) from the remaining live sources, under
        // a NEW transferId, so the recipient still receives the full amount.
        if (err instanceof PartialSendConflictError) {
          deliveredSourceIds.push(...err.committedTokenIds);
          if (primaryPartialTransferId === undefined) primaryPartialTransferId = err.transferId;
          const remaining = BigInt(err.remainingAmount);
          if (remaining > 0n && attempt < MAX_RESELECT_ATTEMPTS) {
            logger.warn(
              'Payments',
              `Partial send: ${err.committedTokenIds.length} leg(s) certified — re-planning ONLY the remaining ${remaining} under a NEW transferId (#677, attempt ${attempt + 1}/${MAX_RESELECT_ATTEMPTS})`,
            );
            currentRequest = { ...request, amount: remaining.toString() };
            continue;
          }
          // Remainder is 0 (defensive) or the attempt budget is exhausted — surface the
          // accumulated partial so the caller re-plans only the shortfall, never the full amount.
          throw new PartialSendConflictError(
            err.message, primaryPartialTransferId, deliveredSourceIds, err.remainingAmount, err.cause,
          );
        }

        // A clean, otherwise re-sendable failure that struck DURING a remainder re-plan
        // (≥1 leg already delivered): the remainder could not be covered (e.g.
        // SEND_INSUFFICIENT_BALANCE) or a transient error hit. Surfacing it bare would
        // make the caller re-send the FULL amount and pay the delivered legs twice — so
        // surface the partial outcome (the insufficient-remainder fallback) carrying what
        // WAS delivered and the shortfall still owed.
        if (deliveredSourceIds.length > 0) {
          throw new PartialSendConflictError(
            'Part of your payment was sent, but the remaining amount could not be completed (insufficient funds, or a transient error during the remainder re-plan — see cause). The delivered portion is final — re-plan only the shortfall, never the full amount.',
            primaryPartialTransferId!, // always set once a leg delivered (deliveredSourceIds is non-empty)
            deliveredSourceIds,
            currentRequest.amount,
            err,
          );
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
    // #679: write the demotion through to any provider that keeps a DURABLE
    // suspected-spent overlay (the wallet-api thin provider). Its save() below
    // pushes only additions + confirmed-spend tombstones, so a suspectedSpent
    // flag on an otherwise-active row is dropped and the phantom resurfaces as
    // spendable `confirmed` on the next reload (SPHERE-4). The overlay is keyed
    // by the genesis tokenId; a lazy record carries no sdkData, so derive it
    // from the `v2_` id. Local whole-blob providers persist the flag via save()
    // and don't implement this hook.
    const genesisId =
      extractTokenIdFromSdkData(token.sdkData) ?? (token.id.startsWith('v2_') ? token.id.slice(3) : null);
    if (genesisId) {
      for (const [, provider] of this.getTokenStorageProviders()) {
        if (typeof provider.markSuspectedSpent !== 'function') continue;
        try {
          await provider.markSuspectedSpent(genesisId);
        } catch (err) {
          logger.warn('Payments', `Failed to persist suspectedSpent overlay for ${genesisId}:`, err);
        }
      }
    }
    try {
      await this.save();
    } catch (err) {
      logger.warn('Payments', `Failed to persist suspectedSpent for ${tokenId} (re-derived on the next conflict):`, err);
    }
  }

  /**
   * Resolve the recipient and assert the two preconditions the v2 send path
   * cannot proceed without: an engine, and a recipient with a PUBLISHED chain
   * pubkey (transfers lock to `SignaturePredicate(chainPubkey)`).
   */
  private async resolveSendTarget(
    request: TransferRequest
  ): Promise<{ peerInfo: PeerInfo & { chainPubkey: string }; recipientPubkey: string }> {
    const peerInfo: PeerInfo | null = await this.deps!.transport.resolve?.(request.recipient) ?? null;
    const recipientPubkey = this.resolveTransportPubkey(request.recipient, peerInfo);
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
    return { peerInfo: peerInfo as PeerInfo & { chainPubkey: string }, recipientPubkey };
  }

  /** Short symbol (`UCT`) → the 64-hex coinId storage uses. Unknown//hex input passes through. */
  private resolveCoinId(coinId: string): string {
    const held = Array.from(this.tokens.values()).some((t) => t.coinId === coinId);
    if (held || coinId.length > 20) return coinId;
    return TokenRegistry.getInstance().getDefinitionBySymbol(coinId)?.id ?? coinId;
  }

  /**
   * Reserve the sources for one send: parse the pool, then plan + reserve in
   * ONE synchronous step so two sends never take the same token
   * (SpendPlanner.planSend → TokenReservationLedger.reserve).
   *
   * A send the free balance cannot cover right now QUEUES on the change token
   * of the send that is holding it, rather than failing outright.
   */
  private async reserveSpendPlan(request: TransferRequest, transferId: string): Promise<SplitPlan> {
    const parsedPool = await this.spendPlanner.buildParsedPool(
      Array.from(this.tokens.values()),
      request.coinId
    );
    // Pending change (a concurrent send's 'transferring' sources) counts toward
    // the inventory the plan may wait for — without it a coverable send would
    // hard-fail SEND_INSUFFICIENT_BALANCE instead of queueing.
    let pendingChangeAmount = 0n;
    for (const [, t] of this.tokens) {
      if (t.coinId === request.coinId && t.status === 'transferring') {
        pendingChangeAmount += BigInt(t.amount || '0');
      }
    }
    const planResult = this.spendPlanner.planSend(
      request, parsedPool, this.reservationLedger, this.spendQueue, transferId, pendingChangeAmount
    );
    const splitPlan =
      planResult === 'queued'
        ? (await this.spendQueue.waitForEntry(transferId)).splitPlan
        : planResult.splitPlan;
    if (!splitPlan) throw new SphereError('Insufficient balance', 'SEND_INSUFFICIENT_BALANCE');
    return splitPlan;
  }

  /**
   * Flag the planned sources 'transferring' and persist. critical (#515 F2):
   * nothing is spent yet, so an unwritable active custody provider must abort
   * the send HERE, before the intent/engine run.
   */
  private async markTransferring(tokens: readonly Token[]): Promise<void> {
    for (const token of tokens) {
      token.status = 'transferring';
      this.tokens.set(token.id, token);
      this.parsedTokenCache.delete(token.id);
    }
    await this.save({ critical: true });
  }

  /**
   * Drop the local backstop copy of an intent the server deterministically
   * rejected — keeping it would poison resyncOpenIntents with an eternal 422.
   */
  private async dropRejectedIntent(walletApi: PaymentsWalletApiPort, transferId: string): Promise<void> {
    try {
      await walletApi.removeLocalIntent?.(transferId);
    } catch (err) {
      logger.warn('Payments', 'removeLocalIntent failed after intent VALIDATION rejection:', err);
    }
  }

  /**
   * Certify one operation on-chain, then JOURNAL its finished blob. Delivery is
   * deliberately not here — it is one hoisted pass over the committed set
   * (#699), so a multi-source send deposits in a single batch.
   *
   * NEVER rejects (a mid-batch rejection would stop us observing still-in-flight
   * siblings) and NEVER touches shared wallet state (`this.tokens` mutations and
   * `save()` are not concurrency-safe — they belong to the sequential apply).
   */
  private async certifyOperation(op: SendOperation, ctx: CertifyContext): Promise<OperationOutcome> {
    let finished: SphereToken;
    let changeOutput: SphereToken | undefined;
    const opts = { signal: timeoutSignal(SEND_ENGINE_OP_TIMEOUT_MS), transferId: ctx.transferId, opIndex: op.opIndex };
    try {
      if (op.kind === 'direct') {
        finished = await ctx.engine.transfer({ token: op.sdkToken, recipientPubkey: ctx.recipientChainPubkey }, opts);
      } else {
        // Value-conserving split: the recipient gets deliveredAmount, this
        // wallet keeps the remainder as a real, immediate change token. E.4:
        // the burn checkpoint persists (durable-ack gated) before the first mint.
        const { outputs } = await ctx.engine.split(
          {
            token: op.sdkToken,
            outputs: [
              { recipientPubkey: ctx.recipientChainPubkey, coinId: ctx.coinId, amount: op.deliveredAmount },
              { recipientPubkey: ctx.selfChainPubkey, coinId: ctx.coinId, amount: op.remainderAmount },
            ],
          },
          { ...opts, ...(ctx.checkpointStore ? { checkpointStore: ctx.checkpointStore } : {}) },
        );
        finished = outputs[0];
        changeOutput = outputs[1];
      }
    } catch (error) {
      // No proof in hand is NOT "never reached the chain": for the keep-open
      // family (isKeepOpenSendError) the submit may have been accepted.
      // certified:false records only what was OBSERVED — the failure
      // disposition keeps the intent open and resume settles it (#631/E.4).
      return { op, certified: false, error };
    }
    // Spent on-chain from here on: every return below reports certified so the
    // accounting counts it even when a local post-step fails.
    const change = changeOutput !== undefined ? { changeOutput } : {};
    try {
      // Journal BEFORE any delivery — the hoisted pass below, or the replay on
      // the next load(), hands it over. A delivery failure or a crash must never
      // lose the recipient's token.
      const tokenBlob = bytesToHex(encodeTokenBlob(ctx.engine.encodeToken(finished)));
      await this.deliveries.savePendingV2Delivery({
        transferId: ctx.transferId,
        recipientPubkey: ctx.recipientChainPubkeyHex,
        tokenBlob,
        ...(ctx.memo !== undefined ? { memo: ctx.memo } : {}),
        opIndex: op.opIndex,
        createdAt: Date.now(),
      });
      return { op, certified: true, tokenBlob, ...change };
    } catch (error) {
      return { op, certified: true, error, ...change };
    }
  }

  /**
   * Certify the send's operations concurrently, MAX_SEND_OPERATION_CONCURRENCY
   * at a time (#684 pacing). Every launched op SETTLES before the caller's
   * accounting runs — the #625 conflict tag and the #677 remainder must never be
   * computed while value may still be certifying in flight.
   *
   * Fail-fast between batches: once any settled op has failed, this send is on
   * the failure path, and launching more would certify value destined for
   * resume/remainder handling (and, in an outage, stack ceil(N/8) op-timeouts
   * before the user sees the error). Never-launched sources stay untouched —
   * restored 'confirmed' by the failure disposition.
   */
  private async certifySendOperations(
    operations: readonly SendOperation[],
    ctx: CertifyContext
  ): Promise<OperationOutcome[]> {
    const outcomes: OperationOutcome[] = [];
    for (let start = 0; start < operations.length; start += MAX_SEND_OPERATION_CONCURRENCY) {
      const batch = operations.slice(start, start + MAX_SEND_OPERATION_CONCURRENCY);
      outcomes.push(...(await Promise.all(batch.map((op) => this.certifyOperation(op, ctx)))));
      if (outcomes.some((o) => o.error !== undefined)) break;
    }
    return outcomes;
  }

  /**
   * §7 steps 4+6, shared by the send and the resume of a send: upload the change
   * output, then record the whole spend in ONE idempotent applyDelta carrying
   * the transferId. The backend evidence-checks the removals against the mailbox
   * deposit of the same transferId (§5.3) and completes the intent in the same
   * transaction (§16).
   *
   * The change is stored locally AFTER the server apply: on this path the
   * awaited intent (E.3) is the recovery seed, and following the apply keeps the
   * provider's write-behind from racing a second add of the same state.
   *
   * The caller passes the provider it read the sources from. Resolving the
   * ACTIVE one here would let a mid-flight `updateTokenStorageProviders()` (an
   * address switch) apply the spend to a different backend than the one that
   * supplied them.
   */
  private async applyInventoryDelta(
    engine: ITokenEngine,
    transferId: string,
    spentStates: readonly { tokenId: string; stateHash: string }[],
    changeOutput: SphereToken | null | undefined,
    /** The SAME provider the sources came from — never re-resolved here (see above). */
    storage: TokenStorageProvider<TxfStorageDataBase>
  ): Promise<void> {
    const added: { tokenId: string; key: string }[] = [];
    if (changeOutput) {
      const changeBytes = encodeTokenBlob(engine.encodeToken(changeOutput));
      added.push({ tokenId: engine.tokenId(changeOutput), key: await this.uploadOutputBlob(changeBytes) });
    }
    await storage.applyDelta(transferId, spentStates.map((s) => s.tokenId), added, { spentStates: [...spentStates] });
    if (changeOutput) await this.storeEngineToken(engine, changeOutput);
  }

  /** The SENT row, with the per-source breakdown the UI lists under it. */
  private async recordSentHistory(ctx: {
    readonly result: MutableTransferResult;
    readonly request: TransferRequest;
    readonly splitPlan: SplitPlan;
    readonly peerInfo: PeerInfo | null;
    readonly recipientPubkey: string;
    readonly recipientNametag: string | undefined;
  }): Promise<void> {
    const { result, request, splitPlan, peerInfo, recipientPubkey, recipientNametag } = ctx;
    const heldAmount = new Map(result.tokens.map((t) => [t.id, t.amount]));
    const tokenIds = result.tokenTransfers.map((tt) => ({
      id: tt.sourceTokenId,
      // A split sent only splitAmount, not the whole source token.
      amount: tt.method === 'split'
        ? (splitPlan.splitAmount?.toString() || '0')
        : (heldAmount.get(tt.sourceTokenId) || '0'),
      source: tt.method === 'split' ? ('split' as const) : ('direct' as const),
    }));
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
      tokenId: (result.tokens[0] ? extractTokenIdFromSdkData(result.tokens[0].sdkData) : undefined) || undefined,
      tokenIds: tokenIds.length > 0 ? tokenIds : undefined,
    });
  }

  /**
   * Close out a send whose value has left the wallet: persist, close the intent,
   * record history, release the reservation, and resolve.
   *
   * §3.1 (#621): the spend is final regardless of delivery — a leg whose
   * delivery was deferred (recipient 429 / transient outage) resolves
   * delivery-pending, with the blob still journaled for replay, rather than
   * failing the sender.
   */
  private async finishSend(ctx: {
    readonly result: MutableTransferResult;
    readonly request: TransferRequest;
    readonly splitPlan: SplitPlan;
    readonly peerInfo: PeerInfo | null;
    readonly recipientPubkey: string;
    readonly recipientNametag: string | undefined;
    readonly deliveryPending: boolean;
  }): Promise<TransferResult> {
    const { result, deliveryPending } = ctx;
    result.status = 'delivered';
    await this.save();
    result.status = 'completed';

    // E.3 uniform close: every finished send ends with completeIntent
    // (idempotent). Under inventory custody the apply already completed it
    // server-side; with own storage this call is the ONLY close — without it
    // every historical send would re-resume at each sign-in forever.
    if (this.deps!.walletApi) {
      try {
        await this.deps!.walletApi.completeIntent(result.id);
      } catch (err) {
        logger.warn('Payments', 'completeIntent failed (the next sign-in resume converges it):', err);
      }
    }

    await this.recordSentHistory(ctx);

    // Every source is spent on-chain and removed — release the reservation.
    this.reservationLedger.commit(result.id);
    if (deliveryPending) result.deliveryPending = true;
    result.deliveryState = deliveryPending ? 'pending-delivery' : 'landed';
    this.deps!.emitEvent(deliveryPending ? 'transfer:delivery_pending' : 'transfer:confirmed', result);
    return result;
  }

  private async sendOnce(request: TransferRequest): Promise<TransferResult> {
    this.ensureInitialized();
    this.ensureDelivery();
    this.ensureWalletApi();

    const result: MutableTransferResult = {
      id: randomUUID(),
      status: 'pending',
      tokens: [],
      tokenTransfers: [],
    };
    const attempt: SendAttemptState = {
      deliveryPending: false,
      onChainCommitComplete: false,
      intentRejected: false,
    };

    try {
      const { peerInfo, recipientPubkey } = await this.resolveSendTarget(request);
      request = { ...request, coinId: this.resolveCoinId(request.coinId) };
      const splitPlan = await this.reserveSpendPlan(request, result.id);
      result.tokens = [
        ...splitPlan.tokensToTransferDirectly.map((t: TokenWithAmount) => t.uiToken),
        ...(splitPlan.tokenToSplit ? [splitPlan.tokenToSplit.uiToken] : []),
      ];
      await this.markTransferring(result.tokens);
      result.status = 'submitted';

      await this.executeSendPlan({ request, result, splitPlan, recipientChainPubkeyHex: peerInfo.chainPubkey, attempt });

      return await this.finishSend({
        result,
        request,
        splitPlan,
        peerInfo,
        recipientPubkey,
        recipientNametag:
          peerInfo.nametag || (request.recipient.startsWith('@') ? request.recipient.slice(1) : undefined),
        deliveryPending: attempt.deliveryPending,
      });
    } catch (error) {
      return await this.failSend({ error, result, request, attempt });
    }
  }

  /**
   * The money core of a send: certify every operation on-chain, journal + deliver
   * the recipient blobs, and record the spend.
   *
   * v2 engine mode (sender-driven) — `engine.transfer` hands the recipient a
   * FINISHED token, so there is no commitment / inclusion-proof / finalization
   * round-trip. Under wallet-api INVENTORY custody the spend is recorded
   * server-side by ONE applyDelta carrying this transferId (the evidence link to
   * the mailbox deposit, §7/§5.3); with 'external' custody the sender never
   * calls apply at all (§6 storage-opt-out) and local bookkeeping is the record.
   */
  private async executeSendPlan(ctx: {
    readonly request: TransferRequest;
    readonly result: MutableTransferResult;
    readonly splitPlan: SplitPlan;
    readonly recipientChainPubkeyHex: string;
    readonly attempt: SendAttemptState;
  }): Promise<void> {
    const { request, result, splitPlan, recipientChainPubkeyHex, attempt } = ctx;
    const engine = this.deps!.tokenEngine!;
    const serverApply = this.delivery!.custody === 'inventory';

    // S2: lazy inventory records selected by coin-selection are materialized
    // (getToken + engine decode) only now, once they are actually being spent.
    await this.materializeSelectedSources(splitPlan);
    await this.openSendIntent(request, result.id, recipientChainPubkeyHex, splitPlan, attempt);

    const summary = summarizeOutcomes(
      await this.certifySendOperations(buildSendOperations(splitPlan), {
        engine,
        transferId: result.id,
        recipientChainPubkey: hexToBytes(recipientChainPubkeyHex),
        recipientChainPubkeyHex,
        selfChainPubkey: hexToBytes(this.deps!.identity.chainPubkey),
        coinId: request.coinId,
        ...(request.memo !== undefined ? { memo: request.memo } : {}),
        ...(this.getCheckpointStore() ? { checkpointStore: this.getCheckpointStore()! } : {}),
      })
    );
    // The failure disposition reads committed accounting EXCLUSIVELY from here
    // (W23-R2/#677): certified sources must never be restored 'confirmed', and
    // the remainder still owed is derived from SETTLED data, so a concurrent
    // certification can never be under-counted (an under-count double-pays).
    attempt.summary = summary;

    // Delivery is hoisted out of the certification fan-out (#699): ONE batched
    // mailbox deposit, or a per-blob loop, over the SETTLED committed set. Runs
    // on the failure path too — committed siblings of a failed batch get their
    // delivery attempt before the throw below. Never throws (§3.1/#621): a
    // deferred blob stays journaled and the send resolves delivery-pending.
    attempt.deliveryPending = !(await this.deliveries.deliverCommittedBlobs(
      summary.committed.flatMap((o) => (o.tokenBlob === undefined ? [] : [o.tokenBlob])),
      recipientChainPubkeyHex,
      result.id,
      request.memo,
    ));

    // Sequential apply — the ONLY writer of shared wallet state. Runs for
    // committed ops even when another op failed: their spend is irreversible
    // (§7). An op that certified but failed a local post-step is left alone —
    // the failure handler marks it 'spent' and resume recovers its journaled blob.
    const consumed = summary.committed.filter((o) => o.error === undefined).map((o) => o.op);
    for (const op of consumed) {
      result.tokenTransfers.push({ sourceTokenId: op.uiTokenId, method: op.kind });
    }
    if (!serverApply) await this.recordLocalSpend(engine, result.id, consumed, summary.changeOutput);
    if (summary.primaryError !== undefined) throw surfacedSendFailure(summary);
    if (!serverApply) return;

    // #665: every on-chain submit has certified, so the wallet-api persistence
    // that follows is post-commit — a failure from here is a server-MIRROR
    // sync-pending converged by resume, not a lost payment. Scoped to this
    // branch: own-storage sends have no mirror to catch up.
    attempt.onChainCommitComplete = true;
    await this.recordServerSpend(engine, result.id, consumed, summary.changeOutput);
  }

  /**
   * Own-storage custody: local bookkeeping IS the record of the spend.
   *
   * critical (#515 F2): an unpersisted change token is value loss on reload, and
   * nothing after the on-chain split may depend on anything else succeeding —
   * fail the send (the open intent resumes it) rather than report success.
   */
  private async recordLocalSpend(
    engine: ITokenEngine,
    transferId: string,
    consumed: readonly SendOperation[],
    changeOutput: SphereToken | null | undefined
  ): Promise<void> {
    if (changeOutput) await this.storeEngineToken(engine, changeOutput, { criticalSave: true });
    // Sequential on purpose — removeToken's save() is an unlocked whole-map write.
    for (const op of consumed) {
      await this.removeToken(op.uiTokenId, transferId, extractStateHashFromSdkData(op.sourceSdkData));
    }
  }

  /**
   * Inventory custody: the spend is recorded server-side by one applyDelta, and
   * the local sources are dropped only after it lands.
   */
  private async recordServerSpend(
    engine: ITokenEngine,
    transferId: string,
    consumed: readonly SendOperation[],
    changeOutput: SphereToken | null | undefined
  ): Promise<void> {
    // M3: derive each source's PROTOCOL spent state (the deliveryKeys imprint =
    // the server's row state_hash) from the source blob we HELD, never from the
    // live view, so knownSpends records the exact state.
    const spentStates = await Promise.all(
      consumed.map(async (op) => ({
        tokenId: op.genesisId,
        stateHash: op.sourceSdkData ? (await engine.deliveryKeys(hexToBytes(op.sourceSdkData))).stateHash : '',
      }))
    );
    const storage = this.getActiveTokenStorageProvider();
    if (!storage) {
      throw new SphereError('No token storage provider available for applyDelta', 'STORAGE_ERROR');
    }
    await this.applyInventoryDelta(engine, transferId, spentStates, changeOutput, storage);
    // M2: each removeToken carries the LOCAL state we spent, so a source the
    // pump already reactivated to a new state is KEPT, not re-tombstoned.
    for (const op of consumed) {
      await this.removeToken(op.uiTokenId, transferId, extractStateHashFromSdkData(op.sourceSdkData));
    }
  }

  /**
   * E.3: the intent is the resume seed, so it is persisted and ACKed BEFORE any
   * engine submit. E.4/#87: `requiresSeedClose` is set here, before the burn, so
   * the funds-critical window is guarded from intent creation.
   */
  private async openSendIntent(
    request: TransferRequest,
    transferId: string,
    recipientChainPubkey: string,
    splitPlan: SplitPlan,
    attempt: SendAttemptState
  ): Promise<void> {
    const walletApi = this.deps!.walletApi!;
    try {
      await walletApi.putIntent(
        transferId,
        encryptField(
          this.getFieldEncryptionKey(),
          JSON.stringify(await this.buildIntentPayload(request, recipientChainPubkey, splitPlan))
        ),
        splitPlan.requiresSplit ? { requiresSeedClose: true } : {}
      );
    } catch (err) {
      // #670: a 422 VALIDATION rejection is DETERMINISTIC (nothing is on-chain —
      // the PUT precedes every engine op — and no server row exists), so the
      // #516 keep-and-replay backstop must NOT apply. Transient failures
      // (NETWORK/5xx) rethrow unchanged and keep it.
      if (err instanceof WalletApiError && err.code === 'VALIDATION') {
        attempt.intentRejected = true;
        await this.dropRejectedIntent(walletApi, transferId);
        throw intentValidationError(err);
      }
      throw err;
    }
  }

  /**
   * Terminal disposition of a failed send attempt. Always throws — every exit
   * is a `throw`, so the caller reads as `return await this.failSend(...)`.
   *
   * Cancels the reservation, decides the intent disposition (abort a proven-clean
   * failure, keep every possibly-certified one OPEN for resume), restores or
   * terminalizes each source token, then re-tags the error for the three outcomes
   * that are NOT plain failures: post-commit mirror lag (SEND_SYNC_PENDING),
   * a partially-delivered lost race (PartialSendConflictError), and the
   * keep-open certification codes.
   */
  private async failSend(ctx: {
    readonly error: unknown;
    readonly result: MutableTransferResult;
    readonly request: TransferRequest;
    readonly attempt: SendAttemptState;
  }): Promise<never> {
    const { error, result, request } = ctx;
    const { summary, onChainCommitComplete, intentRejected } = ctx.attempt;
    this.reservationLedger.cancel(result.id);
    // Empty when the failure struck before any engine op ran (planning, intent PUT).
    const committedUiIds = summary?.committedUiIds ?? new Set<string>();

    result.status = 'failed';
    // A TransferConflictError is a LOST RACE (E.2): another transaction —
    // typically this owner's other device — already consumed a source token.
    result.error = error instanceof TransferConflictError
      ? `Send conflicted: a source token was already spent by a concurrent transfer — re-plan and retry (${error.message})`
      : error instanceof Error ? error.message : String(error);

    // #517: the predictable stale-view race (coin-selection planned from a lazy
    // view that missed another device's spend) was handled but SILENT — surface
    // it so a UI can prompt "refresh and retry" instead of a generic failure.
    if (error instanceof TransferConflictError) {
      this.deps!.emitEvent('inventory:conflict', { transferId: result.id, coinId: request.coinId, error: error.message });
    }
    // E.4: a stuck checkpoint needs the loud signal — never a silent retry.
    if (error instanceof SplitCheckpointLostError || error instanceof CheckpointTrustbaseMismatchError) {
      this.deps!.emitEvent('split:checkpoint-stuck', { transferId: result.id, code: error.code, error: error.message });
    }

    const keepOpen = isKeepOpenSendError(error);
    await this.disposeIntentOnFailure(result.id, { committed: committedUiIds.size > 0, keepOpen, intentRejected });
    await this.restoreSourcesAfterFailure(result, committedUiIds, request.coinId);
    this.throwSendOutcome({
      error,
      result,
      request,
      committedUiIds,
      committedAmount: summary?.committedAmount ?? 0n,
      onChainCommitComplete,
      keepOpen,
    });
  }

  /**
   * Abort the intent, or leave it OPEN for resume (E.2/E.3). ONLY a PROVEN-clean
   * failure with nothing certified aborts — an open intent there would silently
   * re-execute the transfer at the next sign-in, after the user already saw it
   * fail. Everything else keeps the intent, because it is the only resume seed:
   *
   *  - a conflict AFTER ≥1 certified leg — a certified split's change output is
   *    neither uploaded nor stored locally, and resyncOpenIntents lists 'open'
   *    only, so aborting would strand that value;
   *  - any partially-certified failure — forward completion via resume is the
   *    only exit (§7);
   *  - #631 ProofUnconfirmedError — the spend may be on-chain under this
   *    transferId even with an empty committed set (the throw beat the .add());
   *  - E.4 split burn-checkpoint errors — the burn is certified and a split-mint
   *    stateId is HKDF-derived (never a foreign spend), so resume from the
   *    checkpoint is the only exit.
   *
   * A conflict is never keep-open, so the E.2 clean-conflict abort is contained
   * in the same predicate. #670: an intent PUT the server deterministically
   * rejected has no server row — aborting would only 404 and re-mark it.
   */
  private async disposeIntentOnFailure(
    transferId: string,
    flags: { committed: boolean; keepOpen: boolean; intentRejected: boolean }
  ): Promise<void> {
    if (flags.intentRejected || flags.committed || flags.keepOpen) return;
    try {
      await this.deps!.walletApi!.abortIntent(transferId);
    } catch (err) {
      logger.warn('Payments', 'abortIntent failed (soft abort is best-effort):', err);
    }
  }

  /**
   * Put this send's sources back, in three classes (W23-R2/R3):
   *  - already removed during a partially-successful fan-out → skip (restoring
   *    would create phantom tokens);
   *  - certified on-chain during THIS send (tracked, or — for an op that threw
   *    after certification — the network says spent) → terminal 'spent', NEVER
   *    back to 'confirmed': a spent state in the spend pool fails every future send;
   *  - genuinely untouched → 'confirmed' + re-cached for the queue.
   */
  private async restoreSourcesAfterFailure(
    result: MutableTransferResult,
    committedUiIds: ReadonlySet<string>,
    coinId: string
  ): Promise<void> {
    const engine = this.deps?.tokenEngine;
    for (const token of result.tokens) {
      if (!this.tokens.has(token.id)) {
        logger.warn('Payments', `Skipping restoration of already-removed token ${token.id}`);
        continue;
      }
      let spentOnChain = committedUiIds.has(token.id);
      if (!spentOnChain && engine && token.sdkData && looksLikeTokenBlob(token.sdkData)) {
        try {
          spentOnChain = await engine.isSpent(await engine.decodeToken(decodeTokenBlob(hexToBytes(token.sdkData))));
        } catch {
          // Network/decode failure — restore optimistically; validate() or the
          // next send attempt reconciles a stale state.
        }
      }
      token.status = spentOnChain ? 'spent' : 'confirmed';
      this.tokens.set(token.id, token);
      if (spentOnChain) {
        logger.warn('Payments', `Token ${token.id} was spent on-chain during the failed send — marked 'spent' (output blob journaled for delivery replay)`);
      } else {
        await this.cacheEngineParsedToken(token);
      }
    }
    // Without this a crash right after a handled failure reloads the tokens as
    // stuck-'transferring'.
    try {
      await this.save();
    } catch (err) {
      logger.error('Payments', 'Failed to persist send-failure restore:', err);
    }
    // AFTER the cache rebuild, so queued entries see the restored tokens.
    this.spendQueue.notifyChange(coinId);
  }

  /**
   * The terminal throw. Two outcomes are NOT plain failures and must not emit
   * `transfer:failed` — nothing was lost in either:
   *
   *  - #665 post-commit mirror lag: the spend landed on-chain, the intent is
   *    open, resume converges the server mirror. Re-tagged SEND_SYNC_PENDING so
   *    the caller can reassure the user. Excludes a genuine lost race and the
   *    keep-open certification states, which are pre-mirror.
   *  - #677 partial lost race: ≥1 leg already certified and was journaled, so a
   *    bare TransferConflictError would make the caller re-send the FULL amount
   *    and pay the delivered leg twice. Surfaces the committed legs and the
   *    still-owed REMAINDER instead; send() re-plans only that.
   *
   * #441: both, plus the keep-open certification codes, carry this attempt's
   * transferId so a payment-request consumer can journal request→transfer.
   */
  private throwSendOutcome(ctx: {
    readonly error: unknown;
    readonly result: MutableTransferResult;
    readonly request: TransferRequest;
    readonly committedUiIds: ReadonlySet<string>;
    readonly committedAmount: bigint;
    readonly onChainCommitComplete: boolean;
    readonly keepOpen: boolean;
  }): never {
    const { error, result, request, committedUiIds, committedAmount, onChainCommitComplete, keepOpen } = ctx;
    const conflict = error instanceof TransferConflictError;
    if (onChainCommitComplete && !conflict && !keepOpen) {
      const pending = new SphereError(
        'Your payment was sent. Your wallet is syncing with the server and will catch up shortly.',
        'SEND_SYNC_PENDING',
        error,
      );
      pending.transferId = result.id;
      throw pending;
    }
    if (conflict && committedUiIds.size > 0) {
      const remaining = BigInt(request.amount) - committedAmount;
      throw new PartialSendConflictError(
        'Part of your payment was already sent before a source token was spent by a concurrent transfer. Re-plan and send only the remaining amount — do NOT re-send the full amount.',
        result.id,
        [...committedUiIds],
        (remaining > 0n ? remaining : 0n).toString(),
        error as TransferConflictError,
      );
    }
    if (error instanceof SphereError && isPossiblyCommittedSendOutcome(error)) {
      error.transferId ??= result.id;
    }
    this.deps!.emitEvent('transfer:failed', result);
    throw error;
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
   * The E.4 split burn checkpoint store (sphere-sdk#501), or undefined when the composed wallet-api
   * port lacks the progress capability (own-storage / legacy compositions — the documented
   * residual). Memoized. Passed into engine.split() so a split resumed after a certified mint
   * rebuilds its outputs from the durable checkpoint instead of stranding them.
   */
  private getCheckpointStore(): SplitCheckpointStore | undefined {
    const walletApi = this.deps?.walletApi;
    if (!walletApi || typeof walletApi.postIntentProgress !== 'function' || typeof walletApi.getIntentProgress !== 'function') {
      return undefined;
    }
    if (!this.checkpointStore) {
      const post = walletApi.postIntentProgress.bind(walletApi);
      const get = walletApi.getIntentProgress.bind(walletApi);
      this.checkpointStore = new WalletApiCheckpointStore(
        { postIntentProgress: post, getIntentProgress: get },
        this.getFieldEncryptionKey(),
      );
    }
    return this.checkpointStore;
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
      // isSpent checks) sees a complete token record.
      (tw.uiToken as { sdkData?: string }).sdkData = bytesToHex(encodeTokenBlob(blob));
      const live = this.tokens.get(tw.uiToken.id);
      if (live && live !== tw.uiToken) {
        (live as { sdkData?: string }).sdkData = (tw.uiToken as { sdkData?: string }).sdkData;
      }
    }
  }

  /**
   * The E.3 intent payload — `{ sources, recipient, amounts }` concretized to
   * the realization plan, so a resume on ANY device rebuilds byte-identical
   * transactions (same transferId + same inputs + same output order).
   */
  private async buildIntentPayload(
    request: TransferRequest,
    recipientChainPubkey: string,
    splitPlan: SplitPlan
  ): Promise<IntentPayloadV1> {
    const engine = this.deps!.tokenEngine!;
    // M7: capture each source's spent state (BOTH spaces) from the source blob as we hold
    // it now — so a later resume is state-aware without re-reading a claim-advanced view.
    const spentStates: Record<string, { local: string; protocol: string }> = {};
    const recordState = async (tw: TokenWithAmount): Promise<void> => {
      const sdkData = tw.uiToken.sdkData ?? '';
      spentStates[genesisIdOf(tw.uiToken)] = {
        local: extractStateHashFromSdkData(sdkData),
        protocol: sdkData ? (await engine.deliveryKeys(hexToBytes(sdkData))).stateHash : '',
      };
    };
    for (const tw of splitPlan.tokensToTransferDirectly) await recordState(tw);
    if (splitPlan.requiresSplit && splitPlan.tokenToSplit) await recordState(splitPlan.tokenToSplit);
    return {
      v: 2, // E.4: new sends carry the checkpoint-aware resume contract (sphere-sdk#501)
      recipient: recipientChainPubkey,
      coinId: request.coinId,
      amount: request.amount,
      ...(request.memo !== undefined ? { memo: request.memo } : {}),
      direct: splitPlan.tokensToTransferDirectly.map((tw) => genesisIdOf(tw.uiToken)),
      ...(splitPlan.requiresSplit && splitPlan.tokenToSplit
        ? {
            split: {
              tokenId: genesisIdOf(splitPlan.tokenToSplit.uiToken),
              splitAmount: splitPlan.splitAmount!.toString(),
              remainderAmount: splitPlan.remainderAmount!.toString(),
            },
          }
        : {}),
      ...(Object.keys(spentStates).length > 0 ? { spentStates } : {}),
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
        // #679: the provider re-applied its durable suspected-spent overlay to
        // this server-active row (a source proven spent on-chain). Rebuild it
        // demoted so the reload does NOT re-serve the phantom as spendable —
        // getSpendableTokens/coin-selection and aggregateTokens skip it.
        ...(item.suspectedSpent ? { suspectedSpent: true } : {}),
      };
      this.tokens.set(token.id, token);
      merged++;
    }
    if (merged > 0) {
      logger.debug('Payments', `load(): merged ${merged} lazy inventory record(s) — no blobs downloaded (S2)`);
    }
  }

  // ===========================================================================
  // Public API - Payment Requests (owned by {@link PaymentRequests})
  // ===========================================================================

  /** Send a payment request to someone. @see PaymentRequests.sendPaymentRequest */
  sendPaymentRequest(
    recipientPubkeyOrNametag: string,
    request: Omit<PaymentRequest, 'id' | 'createdAt'>
  ): Promise<PaymentRequestResult> {
    return this.requests.sendPaymentRequest(recipientPubkeyOrNametag, request);
  }

  /** Subscribe to incoming payment requests. @see PaymentRequests.onPaymentRequest */
  onPaymentRequest(handler: PaymentRequestHandler): () => void {
    return this.requests.onPaymentRequest(handler);
  }

  /** Get all payment requests. @see PaymentRequests.getPaymentRequests */
  getPaymentRequests(filter?: { status?: PaymentRequestStatus }): IncomingPaymentRequest[] {
    return this.requests.getPaymentRequests(filter);
  }

  /** Count of incoming payment requests with status `'pending'`. @see PaymentRequests.getPendingPaymentRequestsCount */
  getPendingPaymentRequestsCount(): number {
    return this.requests.getPendingPaymentRequestsCount();
  }

  /** Reject a payment request and notify the requester. @see PaymentRequests.rejectPaymentRequest */
  rejectPaymentRequest(requestId: string): Promise<void> {
    return this.requests.rejectPaymentRequest(requestId);
  }

  /** Remove resolved incoming payment requests from memory. @see PaymentRequests.clearProcessedPaymentRequests */
  clearProcessedPaymentRequests(): void {
    this.requests.clearProcessedPaymentRequests();
  }

  /** Remove a specific incoming payment request by ID. @see PaymentRequests.removePaymentRequest */
  removePaymentRequest(requestId: string): void {
    this.requests.removePaymentRequest(requestId);
  }

  /** Pay a payment request directly. @see PaymentRequests.payPaymentRequest */
  payPaymentRequest(requestId: string, memo?: string): Promise<TransferResult> {
    return this.requests.payPaymentRequest(requestId, memo);
  }

  /** Get outgoing payment requests. @see PaymentRequests.getOutgoingPaymentRequests */
  getOutgoingPaymentRequests(filter?: { status?: PaymentRequestStatus }): OutgoingPaymentRequest[] {
    return this.requests.getOutgoingPaymentRequests(filter);
  }

  /** Subscribe to payment request responses. @see PaymentRequests.onPaymentRequestResponse */
  onPaymentRequestResponse(handler: PaymentRequestResponseHandler): () => void {
    return this.requests.onPaymentRequestResponse(handler);
  }

  /** Wait for a response to a payment request. @see PaymentRequests.waitForPaymentResponse */
  waitForPaymentResponse(requestId: string, timeoutMs?: number): Promise<PaymentRequestResponse> {
    return this.requests.waitForPaymentResponse(requestId, timeoutMs);
  }

  /** Cancel an active {@link waitForPaymentResponse} call. @see PaymentRequests.cancelWaitForPaymentResponse */
  cancelWaitForPaymentResponse(requestId: string): void {
    this.requests.cancelWaitForPaymentResponse(requestId);
  }

  /** Remove an outgoing payment request and cancel any pending wait. @see PaymentRequests.removeOutgoingPaymentRequest */
  removeOutgoingPaymentRequest(requestId: string): void {
    this.requests.removeOutgoingPaymentRequest(requestId);
  }

  /** Remove all `'paid'`/`'rejected'`/`'expired'` outgoing requests. @see PaymentRequests.clearCompletedOutgoingPaymentRequests */
  clearCompletedOutgoingPaymentRequests(): void {
    this.requests.clearCompletedOutgoingPaymentRequests();
  }

  /** Pull the wallet-api payment-request streams now (S4). @see PaymentRequests.syncPaymentRequests */
  syncPaymentRequests(): Promise<void> {
    return this.requests.syncPaymentRequests();
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
   * @see Delivery.receive
   */
  receive(
    _options?: ReceiveOptions,
    callback?: (transfer: IncomingTransfer) => void,
  ): Promise<ReceiveResult> {
    return this.deliveries.receive(_options, callback);
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
   * Get total portfolio value in USD.
   * Returns null if PriceProvider is not configured.
   *
   * @see TokenView.getFiatBalance
   */
  getFiatBalance(): Promise<number | null> {
    return this.inventory.getFiatBalance();
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
   * @see TokenView.getBalance
   */
  getBalance(coinId?: string): Asset[] {
    return this.inventory.getBalance(coinId);
  }

  /**
   * Get aggregated assets (tokens grouped by coinId) with price data.
   * Confirmed + unconfirmed tokens make up the spendable balance; in-flight
   * (`'transferring'`) tokens are reported only in the `transferring*` fields
   * and excluded from `totalAmount` (#517 item 3). Fiat value derives from
   * `totalAmount`, so it likewise excludes in-flight value.
   *
   * @see TokenView.getAssets
   */
  getAssets(coinId?: string): Promise<Asset[]> {
    return this.inventory.getAssets(coinId);
  }

  /**
   * Get all tokens, optionally filtered by coin type and/or status.
   *
   * @param filter - Optional filter criteria.
   * @param filter.coinId - Return only tokens of this coin type.
   * @param filter.status - Return only tokens with this status (e.g. `'submitted'` for unconfirmed).
   * @returns Array of matching {@link Token} objects (synchronous).
   * @see TokenView.getTokens
   */
  getTokens(filter?: { coinId?: string; status?: TokenStatus }): Token[] {
    return this.inventory.getTokens(filter);
  }

  /**
   * Get a single token by its local ID.
   *
   * @param id - The local UUID assigned when the token was added.
   * @returns The token, or `undefined` if not found.
   * @see TokenView.getToken
   */
  getToken(id: string): Token | undefined {
    return this.inventory.getToken(id);
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
   *   the old state is dropped and replaced with the incoming one.
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
        // Replace the old state with the newer one
        if (incomingStateHash && existingStateHash && incomingStateHash !== existingStateHash) {
          logger.debug('Payments', `Token ${incomingTokenId?.slice(0, 8)}... state updated: ${existingStateHash.slice(0, 8)}... -> ${incomingStateHash.slice(0, 8)}...`);
          this.tokens.delete(existingId);
          break;
        }

        // CASE 3: No state hashes available - use .id as heuristic
        if (!incomingStateHash || !existingStateHash) {
          if (existingId !== token.id) {
            logger.debug('Payments', `Token ${incomingTokenId?.slice(0, 8)}... .id changed, replacing`);
            this.tokens.delete(existingId);
            break;
          }
        }
      }
    }

    // Add the new token state
    this.tokens.set(token.id, token);
    logger.debug('Payments', `addToken: stored id=${token.id.slice(0, 16)}... mapSize=${this.tokens.size}`);

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


    await this.save();

    // Notify observers (e.g., AccountingModule) that a token was updated
    this.notifyTokenChange(token);

    logger.debug('Payments', `Updated token ${token.id}`);
  }

  /**
   * Remove a token from the wallet.
   *
   * A tombstone `(tokenId, stateHash)` is created to prevent re-addition via
   * a re-delivery. A `SENT` history
   * entry is created unless `skipHistory` is `true`.
   *
   * @param tokenId - Local UUID of the token to remove.
   */
  /**
   * Remove a token we spent. `expectedStateHash` (LOCAL sha256 — the state the caller
   * actually burned) makes this STATE-AWARE (M2): we always tombstone the SPENT state
   * (so a re-delivery of that exact state is deduped), but if the map entry has since
   * advanced to a DIFFERENT state — a concurrent claim reactivated this tokenId (a
   * self-send or A→B→A round-trip direct leg returning at a new state) — that token is
   * legitimately ours, so we KEEP it instead of deleting it. When `expectedStateHash` is
   * omitted (legacy callers) or equals the current state, behavior is byte-identical to
   * before: tombstone the current state and delete.
   */
  async removeToken(tokenId: string, excludeReservationId?: string, expectedStateHash?: string): Promise<void> {
    this.ensureInitialized();

    const token = this.tokens.get(tokenId);
    if (!token) return;

    const currentStateHash = extractStateHashFromSdkData(token.sdkData);
    // The state we actually spent: the caller's expected state, else the current state.
    const spentHash = expectedStateHash !== undefined && expectedStateHash !== '' ? expectedStateHash : currentStateHash;
    const genesisId = extractTokenIdFromSdkData(token.sdkData);

    // Tombstone the SPENT state (never a reactivated newer state).
    this.inventory.tombstoneSpentState(tokenId, genesisId, spentHash);

    // M2: the map entry has advanced past the state we spent → a claim reactivated it →
    // keep the reactivated token; only the spent-state tombstone above stands.
    if (expectedStateHash !== undefined && expectedStateHash !== '' && currentStateHash !== expectedStateHash) {
      logger.debug(
        'Payments',
        `removeToken kept ${tokenId.slice(0, 8)}...: live state ≠ spent state (reactivated by a concurrent claim)`
      );
      await this.save();
      return;
    }

    // The state we spent is (still) the one in the map — remove it.
    // Spend Queue: cancel any OTHER active reservations referencing this token.
    // excludeReservationId prevents cancelling the caller's own in-flight reservation.
    this.reservationLedger.cancelForToken(tokenId, excludeReservationId);
    this.parsedTokenCache.delete(tokenId);


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
   * @see TokenView.getTombstones
   */
  getTombstones(): TombstoneEntry[] {
    return this.inventory.getTombstones();
  }

  /**
   * Check whether a specific `(tokenId, stateHash)` combination is tombstoned.
   * Uses O(1) Set lookup instead of O(n) linear scan.
   *
   * @param tokenId - The genesis token ID.
   * @param stateHash - The state hash of the token version to check.
   * @returns `true` if the exact combination has been tombstoned.
   * @see TokenView.isStateTombstoned
   */
  isStateTombstoned(tokenId: string, stateHash: string): boolean {
    return this.inventory.isStateTombstoned(tokenId, stateHash);
  }

  /**
   * Remove tombstones older than `maxAge` and cap the list at 100 entries.
   *
   * @param maxAge - Maximum age in milliseconds (default: 30 days).
   * @see TokenView.pruneTombstones
   */
  pruneTombstones(maxAge?: number): Promise<void> {
    return this.inventory.pruneTombstones(maxAge);
  }

  // ===========================================================================
  // Public API - Forked Tokens
  // ===========================================================================

  // ===========================================================================
  // Public API - Transaction History
  // ===========================================================================

  /**
   * Get the transaction history sorted newest-first.
   *
   * @returns Array of {@link TransactionHistoryEntry} objects in descending timestamp order.
   * @see TransferHistory.getHistory
   */
  getHistory(): TransactionHistoryEntry[] {
    return this.history.getHistory();
  }

  /**
   * Append an entry to the transaction history.
   *
   * A unique `id` and `dedupKey` are auto-generated. The entry is persisted to
   * the local token storage provider's `history` store (IndexedDB / file).
   * Duplicate entries with the same `dedupKey` are silently ignored (upsert).
   *
   * @param entry - History entry fields (without `id` and `dedupKey`).
   * @see TransferHistory.addToHistory
   */
  addToHistory(entry: Omit<TransactionHistoryEntry, 'id' | 'dedupKey'>): Promise<void> {
    return this.history.addToHistory(entry);
  }

  /**
   * Load history into the in-memory cache.
   *
   * @see TransferHistory.loadHistory
   */
  loadHistory(): Promise<void> {
    return this.history.loadHistory();
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
   * Flush local token state to every configured token storage provider.
   *
   * Named `sync` for history: it once merged remote TXF state back in, which
   * only IPFS ever supplied. The remaining providers all implement `sync()` as
   * "save and return the input unchanged", so this is a write, and the returned
   * counts are always zero.
   */
  async sync(): Promise<{ added: number; removed: number }> {
    this.ensureInitialized();

    // Coalesce: a fire-and-forget flush plus an immediate caller flush would
    // otherwise race the same write.
    if (this._syncInProgress) return this._syncInProgress;

    this._syncInProgress = this._doFlush();
    try {
      return await this._syncInProgress;
    } finally {
      this._syncInProgress = null;
    }
  }

  private async _doFlush(): Promise<{ added: number; removed: number }> {
    this.deps!.emitEvent('sync:started', { source: 'payments' });
    try {
      await this.save();
      this.deps!.emitEvent('sync:completed', { source: 'payments', count: this.tokens.size });
      return { added: 0, removed: 0 };
    } catch (error) {
      this.deps!.emitEvent('sync:error', {
        source: 'payments',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
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
    }
  }

  /**
   * Validate all tokens against the aggregator (oracle provider).
   *
   * Tokens that fail validation or are detected as spent are marked `'invalid'`.
   *
   * @returns Object with arrays of valid and invalid tokens.
   * @see TokenView.validate
   */
  validate(): Promise<{ valid: Token[]; invalid: Token[] }> {
    return this.inventory.validate();
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
  // Delivery port: incoming pump + intent resume (sdk-changes S3/E.3)
  // ===========================================================================

  private teardownDeliveryPump(): void {
    this.deliveryWakeUnsub?.();
    this.deliveryWakeUnsub = null;
    // A wake that landed within the debounce window must not survive teardown:
    // destroy() leaves `deps` set, so a surviving callback would resyncInventory()
    // into a wallet that was just cleared, or across an address switch.
    if (this.inventoryDebounceTimer !== null) {
      clearTimeout(this.inventoryDebounceTimer);
      this.inventoryDebounceTimer = null;
    }
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
        this.pumpHealth.run('delivery', () => this.pumpIncomingDeliveries());
        return;
      case 'inventory':
        this.debouncedInventorySyncFromWake();
        return;
      case 'payment_requests':
        this.pumpHealth.run('payment-requests', () => this.requests.pumpPaymentRequests());
        return;
    }
  }

  /**
   * Debounced inventory resync driven by an `inventory` wake — coalesces a
   * burst of wakes into one pull. Unlike the poll backstop, a wake DOES want
   * the trailing re-run (rerunOnCoalesce=true): if it coalesces onto a load
   * that started before the wake's change, that re-run is what converges it
   * without waiting for the next poll tick.
   */
  private debouncedInventorySyncFromWake(): void {
    if (this.inventoryDebounceTimer) {
      clearTimeout(this.inventoryDebounceTimer);
    }
    this.inventoryDebounceTimer = setTimeout(() => {
      this.inventoryDebounceTimer = null;
      this.pumpHealth.run('inventory', () => this.resyncInventory(true));
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
  private async resyncInventory(rerunOnCoalesce = true): Promise<void> {
    const before = this.tokens.size;
    await this.loadWith(rerunOnCoalesce);
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
    if (!this.delivery) return 0;
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

  private doPumpIncomingDeliveries(): Promise<number> {
    // #724: the drain and a load must never overlap — in EITHER direction.
    return this.withTokenMap(() => this.drainIncomingDeliveries());
  }

  private async drainIncomingDeliveries(): Promise<number> {
    const delivery = this.delivery!;
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
    const verdict = await this.deliveries.handleV2Transfer(payload, incoming.senderPubkey ?? '');
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
  // Public API - Intent Resume (E.3/E.4)
  // ===========================================================================

  /**
   * E.3 resume of this wallet's OPEN send intents.
   *
   * @see IntentResume.resumeOpenIntents
   */
  resumeOpenIntents(): Promise<{ resumed: string[]; conflicted: string[]; failed: string[] }> {
    return this.intents.resumeOpenIntents();
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
    logger.debug('Payments', `save(): providers=${providers.size}, tokens=${this.tokens.size}`);

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

  private async createStorageData(): Promise<TxfStorageDataBase> {
    const sorted = this.history.getHistory();
    return await buildTxfStorageData(
      Array.from(this.tokens.values()),
      {
        version: 1,
        address: this.deps!.identity.chainPubkey,
        ipnsName: this.deps!.identity.ipnsName ?? '',
      },
      {
        nametags: this.nametags,
        tombstones: this.inventory.tombstoneList,
        historyEntries: sorted.slice(0, MAX_SYNCED_HISTORY_ENTRIES),
      }
    ) as unknown as TxfStorageDataBase;
  }

  private loadFromStorageData(data: TxfStorageDataBase): void {
    const parsed = parseTxfStorageData(data);
    logger.debug('Payments', `loadFromStorageData: parsed ${parsed.tokens.length} tokens, ${parsed.tombstones.length} tombstones, errors=[${parsed.validationErrors.join('; ')}]`);

    // Load tombstones FIRST so we can filter tokens
    this.inventory.setTombstones(parsed.tombstones);
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
    this.nametags = parsed.nametags;
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  /**
   * Assets ride the delivery port exclusively — there is no fallback rail, so a
   * composition without one fails here rather than at a null dereference deep in
   * the send path.
   */
  /**
   * E.3: the intent is the ONLY resume seed for a possibly-already-certified
   * transfer, and it lives server-side. Every shipped preset composes `walletApi`
   * alongside `delivery`, so this can only fire for a bundle assembled by hand
   * through `createSphereProviders` — where sending would otherwise certify
   * on-chain with nothing to resume from.
   */
  private ensureWalletApi(): void {
    if (!this.deps!.walletApi) {
      throw new SphereError(
        'No wallet-api client composed — cannot send. The E.3 intent is the only resume seed for a ' +
          'certified transfer; sending without it would leave a spend unrecoverable after a crash.',
        'INVALID_CONFIG'
      );
    }
  }

  private ensureDelivery(): void {
    if (!this.delivery) {
      throw new SphereError(
        'No delivery provider composed — cannot send or receive assets. Compose a wallet-api preset ' +
          '(impl/shared/wallet-api/composition.ts) or supply your own DeliveryProvider.',
        'INVALID_CONFIG'
      );
    }
  }

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
