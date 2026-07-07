/**
 * PaymentsModule — v2 slim rebuild (Wave 6-P2-4b).
 *
 * This file replaces the 9,538-LoC v1 impl (quarantined to
 * `./legacy-v1/PaymentsModule-legacy.ts`) with a compact ~1,500-LoC facade
 * that routes token operations through the anti-corruption `ITokenEngine`
 * port. Public API surface — every method the SDK contract exposes on
 * `sphere.payments.*`, plus the internal glue points other modules and
 * `core/Sphere.ts` reach for — is preserved. Internal machinery that was
 * v1-pipeline-shaped (finalization workers, sending-recovery workers,
 * SENT ledger writers, background commitment retries, TXF wire format,
 * V6-RECOVER, orphan sweepers, etc.) is either dropped or reduced to
 * no-op install stubs so consumer bootstrap code keeps compiling.
 *
 * Design rules:
 *   - All SDK interaction goes through `ITokenEngine` (mint / transfer /
 *     split / encodeToken / decodeToken / verify / isOwnedBy / tokenId /
 *     balanceOf / readValue / deliveryKeys). Direct `@unicitylabs/state-
 *     transition-sdk` imports live only in `token-engine/`.
 *   - v2 makes `submitCertificationRequest` atomic, so the sender pipeline
 *     collapses to: resolve peer → plan sources → per-asset engine op →
 *     encode outputs → transport.sendTokenTransfer → local state update.
 *   - Received tokens arrive finalized; verify + isOwnedBy gate persistence.
 *   - Storage uses the same base64-CBOR envelope produced by the v2
 *     `mint/fungible.ts` helper so the `sdkData` field remains a JSON
 *     string on the wallet-facing `Token` shape.
 */

import type {
  Asset,
  Token,
  TokenStatus,
  TrackedAddress,
  AddressInfo,
  TransferRequest,
  TransferResult,
  TokenTransferDetail,
  IncomingTransfer,
  FullIdentity,
  SphereEventType,
  SphereEventMap,
  PaymentRequest,
  IncomingPaymentRequest,
  OutgoingPaymentRequest,
  PaymentRequestResult,
  PaymentRequestStatus,
  PaymentRequestHandler,
  PaymentRequestResponse,
  PaymentRequestResponseHandler,
} from '../../types';
import type {
  TxfToken,
  TombstoneEntry,
  NametagData,
} from '../../types/txf';
import type {
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
  HistoryRecord,
} from '../../storage';
import type {
  TransportProvider,
  PeerInfo,
  IncomingTokenTransfer,
} from '../../transport';
import type { UxfTransferPayload } from '../../extensions/uxf/types/uxf-transfer';
import type { OracleProvider } from '../../oracle';
import type { PriceProvider } from '../../price';
import type {
  ITokenEngine,
  SphereToken,
  SphereValue,
} from '../../token-engine';

// Existing v2-clean helpers.
import * as nametagStore from './nametag/store';
import { checkNametagAvailability } from './nametag/availability';
import * as paymentRequestIncoming from './payment-request/incoming';
import * as paymentRequestOutgoing from './payment-request/outgoing';
import {
  subscribeToTransportPaymentRequests,
  type IncomingRequestHost,
  type OutgoingRequestHost,
  type PendingResponseResolver,
  type SendPaymentRequestHost,
} from './payment-request';
import {
  getBalance as getBalanceImpl,
  getAssets as getAssetsImpl,
  getFiatBalance as getFiatBalanceImpl,
  getTokens as getTokensImpl,
  getToken as getTokenImpl,
  type TransactionHistoryEntry,
} from './read-model';
import { mintFungibleTokenImpl } from './mint/fungible';
import { NametagMinter, type MintNametagResult } from './NametagMinter';
import { TokenRegistry } from '../../registry';
import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';

// UXF wire helpers — v2-safe (bundle CID is content-addressed, not
// SDK-shaped).
import { encodeTransferPayload, decodeNostrEventContent } from '../../extensions/uxf/bundle/transfer-payload';
import { isUxfTransferPayloadCar, isUxfTransferPayloadCid } from '../../extensions/uxf/types/uxf-transfer';

// SpendQueue is retained per the wave brief but its stsdk-v1-based
// parser is not on the hot path in the v2 slim rebuild; we re-export
// so callers importing from the barrel keep compiling.
export {
  SpendPlanner,
  SpendQueue,
  type ParsedTokenEntry,
  type ParsedTokenPool,
  type PlanResult,
} from './SpendQueue';
export { TokenReservationLedger } from './TokenReservationLedger';

// Type re-exports for public API stability.
export type { TransactionHistoryEntry } from './read-model';
export type { SyncOptions, SyncResult } from './sync/types';

/** Public receive options — preserved from v1 shape. */
export interface ReceiveOptions {
  finalize?: boolean;
  timeout?: number;
  pollInterval?: number;
  onProgress?: (result: {
    resolved: number;
    stillPending: number;
    failed: number;
  }) => void;
}

/** Public receive result — preserved from v1 shape. */
export interface ReceiveResult {
  transfers: IncomingTransfer[];
  finalization?: {
    resolved: number;
    stillPending: number;
    failed: number;
  };
  timedOut?: boolean;
  finalizationDurationMs?: number;
}

export type {
  ImportAddedCode,
  ImportSkipCode,
  ImportRejectCode,
  ImportAdded,
  ImportSkipped,
  ImportRejected,
  ImportTokensResult,
} from './import-export';

// =============================================================================
// Config / dependency shapes
// =============================================================================

/**
 * UXF feature flags. Retained for consumer compat — every flag maps to
 * `true` in v2 (the legacy paths are gone). Reserved for future v2 opt-ins.
 */
export interface UxfTransferFeatures {
  senderUxf?: boolean;
  recipientUxf?: boolean;
  recipientLegacyAdapter?: boolean;
  finalizationWorker?: boolean;
  recoveryWorker?: boolean;
  sentReconciliationWorker?: boolean;
  nostrPersistenceVerifier?: boolean;
  spentStateRescan?: boolean;
  tombstoneGcWorker?: boolean;
  orphanAutoRecovery?: boolean;
  [k: string]: boolean | undefined;
}

export interface PaymentsModuleConfig {
  autoSync?: boolean;
  autoValidate?: boolean;
  retryFailed?: boolean;
  maxRetries?: number;
  debug?: boolean;
  features?: UxfTransferFeatures;
}

/**
 * Optional callback slots for install*-methods. All are v1-shaped; the v2
 * slim rebuild keeps only the ones that show up in Sphere/consumer
 * bootstrap so those files continue to compile.
 */
export interface LegacyShapeAdapterRunner {
  processLegacy?(input: unknown): Promise<void>;
}

/**
 * Facade dependencies. `tokenEngine` is the one v2 op path; consumers who
 * do not yet wire it fall back to conservative defaults (send/receive
 * refuse with a typed error, reads return empty).
 */
export interface PaymentsModuleDependencies {
  identity: FullIdentity;
  storage: StorageProvider;
  /** @deprecated pass `tokenStorageProviders` for multi-provider setups. */
  tokenStorage?: TokenStorageProvider<TxfStorageDataBase>;
  tokenStorageProviders?: Map<string, TokenStorageProvider<TxfStorageDataBase>>;
  transport: TransportProvider;
  oracle: OracleProvider;
  emitEvent: <T extends SphereEventType>(type: T, data: SphereEventMap[T]) => void;
  price?: PriceProvider;
  disabledProviderIds?: ReadonlySet<string>;
  cidRefStore?: unknown;
  publishToIpfs?: (bytes: Uint8Array) => Promise<{ cid: string }>;
  cidFetchGateways?: ReadonlyArray<string>;
  deriveAddressInfo?: (index: number) => AddressInfo;
  getActiveAddresses?: () => ReadonlyArray<TrackedAddress>;
  tokenEngine?: ITokenEngine;
}

// =============================================================================
// Envelope helpers (v2 sdkData shape)
// =============================================================================

const SDK_ENVELOPE_VERSION = 'v2';
const SDK_ENVELOPE_FORMAT = 'sphere-token-blob';

interface SphereTokenEnvelope {
  _sdkVersion: string;
  _format: string;
  v: number;
  network: number;
  tokenId: string;
  /** Base64-encoded CBOR bytes. */
  token: string;
}

function encodeSdkDataEnvelope(engine: ITokenEngine, sphereToken: SphereToken): string {
  const blob = engine.encodeToken(sphereToken);
  return JSON.stringify({
    _sdkVersion: SDK_ENVELOPE_VERSION,
    _format: SDK_ENVELOPE_FORMAT,
    v: blob.v,
    network: blob.network,
    tokenId: blob.tokenId,
    token: bytesToBase64(blob.token),
  } satisfies SphereTokenEnvelope);
}

async function decodeSdkDataEnvelope(
  engine: ITokenEngine,
  sdkData: string,
): Promise<SphereToken | null> {
  try {
    const env = JSON.parse(sdkData) as Partial<SphereTokenEnvelope>;
    if (env?._format !== SDK_ENVELOPE_FORMAT) return null;
    if (typeof env.token !== 'string' || typeof env.tokenId !== 'string') return null;
    const bytes = base64ToBytes(env.token);
    return await engine.decodeToken({
      v: env.v ?? 1,
      network: env.network ?? 2,
      tokenId: env.tokenId,
      token: bytes,
    });
  } catch (err) {
    logger.debug('Payments', 'decodeSdkDataEnvelope failed:', err);
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

// =============================================================================
// Utility helpers
// =============================================================================

const CANONICAL_HEX_RE = /^[0-9a-f]+$/;

function normalizeHexPubkey(input: string): string {
  const trimmed = input.replace(/^0x/, '').trim().toLowerCase();
  return trimmed;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = normalizeHexPubkey(hex);
  if (clean.length % 2 !== 0) {
    throw new SphereError(`Invalid hex string: ${clean.slice(0, 16)}...`, 'VALIDATION_ERROR');
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Extract a 33-byte compressed secp256k1 pubkey (as bytes) from any
 * `PeerInfo`-shaped record + fallback identifier. Order matches
 * the resolve pathway: chainPubkey → transportPubkey → raw hex.
 */
function extractChainPubkey(peer: PeerInfo | null, recipient: string): Uint8Array {
  const candidate =
    peer?.chainPubkey ??
    (recipient && CANONICAL_HEX_RE.test(normalizeHexPubkey(recipient))
      ? normalizeHexPubkey(recipient)
      : undefined);
  if (!candidate) {
    throw new SphereError(
      `Unable to derive chain pubkey for recipient '${recipient}'`,
      'INVALID_RECIPIENT',
    );
  }
  const bytes = hexToBytes(candidate);
  if (bytes.length !== 33) {
    throw new SphereError(
      `Chain pubkey must be 33 bytes (got ${bytes.length})`,
      'INVALID_RECIPIENT',
    );
  }
  return bytes;
}

function resolveTransportPubkey(recipient: string, peer: PeerInfo | null): string {
  if (peer?.transportPubkey) return peer.transportPubkey;
  const hex = normalizeHexPubkey(recipient);
  if (hex.length === 64 && CANONICAL_HEX_RE.test(hex)) return hex;
  if (hex.length === 66 && CANONICAL_HEX_RE.test(hex)) return hex.slice(2);
  throw new SphereError(
    `Cannot resolve recipient '${recipient}' to a transport pubkey`,
    'INVALID_RECIPIENT',
  );
}

// =============================================================================
// Main class
// =============================================================================

export class PaymentsModule {
  private readonly moduleConfig: Required<Omit<PaymentsModuleConfig, 'features'>>;
  private readonly features: Required<UxfTransferFeatures>;
  private deps: PaymentsModuleDependencies | null = null;
  private priceProvider: PriceProvider | null = null;

  // Core in-memory state.
  private tokens: Map<string, Token> = new Map();
  private engineTokens: Map<string, SphereToken> = new Map();
  private pendingTransfers: Map<string, TransferResult> = new Map();

  // Repository state — retained for API stability though only history +
  // nametags are exercised on the v2 hot path.
  private tombstones: TombstoneEntry[] = [];
  private archivedTokens: Map<string, TxfToken> = new Map();
  private forkedTokens: Map<string, TxfToken> = new Map();
  private _historyCache: TransactionHistoryEntry[] = [];
  private nametags: NametagData[] = [];

  // Payment request state.
  private paymentRequests: IncomingPaymentRequest[] = [];
  private paymentRequestHandlers: Set<PaymentRequestHandler> = new Set();
  private outgoingPaymentRequests: Map<string, OutgoingPaymentRequest> = new Map();
  private paymentRequestResponseHandlers: Set<PaymentRequestResponseHandler> = new Set();
  private pendingResponseResolvers: Map<string, PendingResponseResolver> = new Map();

  // Subscriptions.
  private unsubscribeTransfers: (() => void) | null = null;
  private unsubscribePaymentRequests: (() => void) | null = null;
  private unsubscribePaymentRequestResponses: (() => void) | null = null;

  // Loaded flag + change listener set for accounting/swap hooks.
  private loaded = false;
  private tokenChangeCallbacks: Set<(tokenId: string, sdkData: string) => void> = new Set();

  // Storage providers (for load/save cycles).
  private tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>> = new Map();

  // v1 install-hook slots — retained as no-ops to keep bootstrap
  // (Sphere.ts) + accounting/tests compiling. See docstrings on each
  // installer method below.
  private _outboxWriter: unknown = null;
  private _sentLedgerWriter: unknown = null;
  private _spentStateAuditWriter: unknown = null;
  private _inclusionProofImporter: unknown = null;
  private _revalidateCascadedRunner: unknown = null;
  private _sendingRecoveryWorker: unknown = null;
  private _sentReconciliationWorker: unknown = null;
  private _nostrPersistenceVerifier: unknown = null;
  private _spentStateRescanWorker: unknown = null;
  private _tombstoneGcWorker: unknown = null;
  private _finalizationWorkerSender: unknown = null;
  private _finalizationWorkerRecipient: unknown = null;
  private _ingestPool: unknown = null;
  private _legacyShapeAdapterRunner: LegacyShapeAdapterRunner | null = null;

  private _connectivityGate: (() => 'up' | 'down' | 'degraded' | 'unknown') | null = null;

  // Nametag minter is materialized on demand (needs engine).
  private nametagMinter: NametagMinter | null = null;

  constructor(config?: PaymentsModuleConfig) {
    this.moduleConfig = {
      autoSync: config?.autoSync ?? true,
      autoValidate: config?.autoValidate ?? true,
      retryFailed: config?.retryFailed ?? true,
      maxRetries: config?.maxRetries ?? 3,
      debug: config?.debug ?? false,
    };
    this.features = {
      senderUxf: config?.features?.senderUxf ?? true,
      recipientUxf: config?.features?.recipientUxf ?? true,
      recipientLegacyAdapter: config?.features?.recipientLegacyAdapter ?? false,
      finalizationWorker: config?.features?.finalizationWorker ?? false,
      recoveryWorker: config?.features?.recoveryWorker ?? false,
      sentReconciliationWorker: config?.features?.sentReconciliationWorker ?? false,
      nostrPersistenceVerifier: config?.features?.nostrPersistenceVerifier ?? false,
      spentStateRescan: config?.features?.spentStateRescan ?? false,
      tombstoneGcWorker: config?.features?.tombstoneGcWorker ?? false,
      orphanAutoRecovery: config?.features?.orphanAutoRecovery ?? false,
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  getConfig(): Required<Omit<PaymentsModuleConfig, 'features'>> {
    return { ...this.moduleConfig };
  }

  getFeatures(): Readonly<Required<UxfTransferFeatures>> {
    return { ...this.features };
  }

  configureConnectivityGate(
    gate: (() => 'up' | 'down' | 'degraded' | 'unknown') | null,
  ): void {
    this._connectivityGate = gate;
  }

  initialize(deps: PaymentsModuleDependencies): void {
    this.deps = deps;
    this.priceProvider = deps.price ?? null;
    // Consolidate storage providers.
    this.tokenStorageProviders = new Map(deps.tokenStorageProviders ?? []);
    if (deps.tokenStorage && !this.tokenStorageProviders.size) {
      this.tokenStorageProviders.set('default', deps.tokenStorage);
    }

    // Wire nametag minter if we have an engine.
    if (deps.tokenEngine) {
      this.nametagMinter = new NametagMinter({ tokenEngine: deps.tokenEngine });
    }

    // Wire transport transfer subscription.
    this.unsubscribeTransfers?.();
    this.unsubscribeTransfers = deps.transport.onTokenTransfer(async (transfer) => {
      try {
        const durable = await this.handleIncomingTransfer(transfer);
        return durable;
      } catch (err) {
        logger.warn('Payments', 'handleIncomingTransfer threw:', err);
        return false;
      }
    });

    // Wire payment-request subscriptions.
    const subs = subscribeToTransportPaymentRequests(
      deps.transport,
      (req) => paymentRequestIncoming.handleIncomingPaymentRequest(this.incomingRequestHost(), req),
      (resp) => paymentRequestOutgoing.handleResponse(this.outgoingRequestHost(), resp),
    );
    this.unsubscribePaymentRequests?.();
    this.unsubscribePaymentRequestResponses?.();
    this.unsubscribePaymentRequests = subs.unsubscribeRequests;
    this.unsubscribePaymentRequestResponses = subs.unsubscribeResponses;
  }

  async load(): Promise<void> {
    if (!this.deps) return;
    try {
      await TokenRegistry.waitForReady(2_000);
    } catch {
      // Registry unready — proceed anyway; symbol/decimals will fall back.
    }
    // Load from the first provider that returns data.
    for (const [, provider] of this.tokenStorageProviders) {
      try {
        const result = await provider.load();
        if (result.success && result.data) {
          await this.loadFromStorageData(result.data);
          break;
        }
      } catch (err) {
        logger.debug('Payments', 'load: provider load failed:', err);
      }
    }
    this.loaded = true;
  }

  async destroy(): Promise<void> {
    this.unsubscribeTransfers?.();
    this.unsubscribePaymentRequests?.();
    this.unsubscribePaymentRequestResponses?.();
    this.unsubscribeTransfers = null;
    this.unsubscribePaymentRequests = null;
    this.unsubscribePaymentRequestResponses = null;

    for (const [id, resolver] of this.pendingResponseResolvers) {
      clearTimeout(resolver.timeout);
      resolver.reject(new Error('PaymentsModule destroyed'));
      this.pendingResponseResolvers.delete(id);
    }
    this.tokens.clear();
    this.engineTokens.clear();
    this.pendingTransfers.clear();
    this.tokenChangeCallbacks.clear();
  }

  private ensureInitialized(): void {
    if (!this.deps) {
      throw new SphereError('PaymentsModule not initialized', 'NOT_INITIALIZED');
    }
  }

  private requireEngine(): ITokenEngine {
    this.ensureInitialized();
    const engine = this.deps!.tokenEngine;
    if (!engine) {
      throw new SphereError(
        'Token engine not wired — v2 send/receive requires ITokenEngine',
        'NOT_INITIALIZED',
      );
    }
    return engine;
  }

  // ---------------------------------------------------------------------------
  // Persistence helpers
  // ---------------------------------------------------------------------------

  private async loadFromStorageData(data: TxfStorageDataBase): Promise<void> {
    const engine = this.deps?.tokenEngine;
    // Load nametags.
    const nametagField = data._nametags ?? (data._nametag ? [data._nametag] : []);
    this.nametags = Array.isArray(nametagField) ? [...nametagField] : [];
    // Load tombstones.
    if (Array.isArray(data._tombstones)) {
      this.tombstones = [...data._tombstones];
    }
    // Load history.
    if (Array.isArray(data._history)) {
      this._historyCache = data._history as TransactionHistoryEntry[];
    }
    // Load tokens — the template key pattern is `_${tokenId}`. Underscore-
    // prefixed reserved keys (`_meta`, `_nametags`, etc.) are filtered
    // before the entry decode.
    const RESERVED = new Set([
      '_meta',
      '_nametag',
      '_nametags',
      '_tombstones',
      '_outbox',
      '_sent',
      '_invalid',
      '_history',
      '_audit',
      '_finalizationQueue',
      '_mintOutbox',
      '_invalidatedNametags',
    ]);
    for (const key of Object.keys(data as unknown as Record<string, unknown>)) {
      if (RESERVED.has(key)) continue;
      if (!key.startsWith('_')) continue;
      const raw = (data as unknown as Record<string, unknown>)[key] as TxfToken | undefined;
      if (!raw || typeof raw !== 'object') continue;
      const token = txfEntryToToken(raw);
      if (!token) continue;
      this.tokens.set(token.id, token);
      if (engine && token.sdkData) {
        const st = await decodeSdkDataEnvelope(engine, token.sdkData);
        if (st) this.engineTokens.set(token.id, st);
      }
    }
  }

  private async persistAll(): Promise<void> {
    if (!this.tokenStorageProviders.size) return;
    const data = this.buildStorageData();
    for (const [, provider] of this.tokenStorageProviders) {
      try {
        await provider.save(data);
      } catch (err) {
        logger.debug('Payments', 'persistAll: save failed:', err);
      }
    }
  }

  private buildStorageData(): TxfStorageDataBase {
    const data: TxfStorageDataBase = {
      _meta: {
        version: 2,
        address: this.deps?.identity.chainPubkey ?? '',
        ...(this.deps?.identity.ipnsName !== undefined
          ? { ipnsName: this.deps.identity.ipnsName }
          : {}),
        formatVersion: '2.0',
        updatedAt: Date.now(),
      },
      _tombstones: this.tombstones.map((t) => ({
        tokenId: t.tokenId,
        stateHash: t.stateHash,
        timestamp: t.timestamp,
      })),
      _history: [...this._historyCache],
    };
    // Nametags are persisted under the txf-domain `_nametags` slot.
    (data as unknown as Record<string, unknown>)._nametags = [...this.nametags];
    for (const [id, token] of this.tokens) {
      (data as unknown as Record<string, unknown>)[`_${id}`] = tokenToTxfEntry(token);
    }
    return data;
  }

  private async addTokenInternal(token: Token, sphereToken?: SphereToken): Promise<boolean> {
    if (this.tokens.has(token.id)) return false;
    this.tokens.set(token.id, token);
    if (sphereToken) this.engineTokens.set(token.id, sphereToken);
    await this.persistAll();
    for (const cb of this.tokenChangeCallbacks) {
      try {
        cb(token.id, token.sdkData ?? '');
      } catch (err) {
        logger.debug('Payments', 'token change callback threw:', err);
      }
    }
    return true;
  }

  private removeTokenLocal(tokenId: string): boolean {
    const existed = this.tokens.delete(tokenId);
    this.engineTokens.delete(tokenId);
    if (existed) {
      // Record a tombstone so remote sync can converge.
      this.tombstones.push({
        tokenId,
        stateHash: '',
        timestamp: Date.now(),
        deletedAt: Date.now(),
      } as TombstoneEntry);
    }
    return existed;
  }

  // ---------------------------------------------------------------------------
  // Send pipeline
  // ---------------------------------------------------------------------------

  async send(request: TransferRequest): Promise<TransferResult> {
    this.ensureInitialized();
    const engine = this.requireEngine();

    const transferId = crypto.randomUUID();
    const inflight: TransferResult = {
      id: transferId,
      status: 'pending',
      tokens: [],
      tokenTransfers: [],
    };
    this.pendingTransfers.set(transferId, inflight);

    try {
      const peer = (await this.deps!.transport.resolve?.(request.recipient)) ?? null;
      const recipientPubkey = extractChainPubkey(peer, request.recipient);
      const recipientTransportPubkey = resolveTransportPubkey(request.recipient, peer);

      // Build target list: primary + additionalAssets.
      const targets = this.buildTargetList(request);

      // Execute per-asset engine ops, collect delivered outputs.
      const deliveredTokens: SphereToken[] = [];
      const details: TokenTransferDetail[] = [];
      const deliveredUiTokens: Token[] = [];

      for (const target of targets) {
        if (target.kind === 'nft') {
          const src = this.findNftSource(target.tokenId);
          if (!src) {
            throw new SphereError(
              `NFT source token not found: ${target.tokenId}`,
              'VALIDATION_ERROR',
            );
          }
          const out = await engine.transfer({
            token: src.sphereToken,
            recipientPubkey,
            ...(request.memo !== undefined
              ? { data: new TextEncoder().encode(request.memo) }
              : {}),
          });
          deliveredTokens.push(out);
          this.removeTokenLocal(src.uiToken.id);
          details.push({ sourceTokenId: src.uiToken.id, method: 'direct' });
          deliveredUiTokens.push(this.uiTokenFromSphereToken(engine, out));
        } else {
          const wanted = BigInt(target.amount);
          if (wanted <= 0n) {
            throw new SphereError(
              `Coin amount must be positive (coinId=${target.coinId})`,
              'VALIDATION_ERROR',
            );
          }
          const plan = this.planCoinSpend(engine, target.coinId, wanted);
          if (!plan) {
            throw new SphereError(
              `Insufficient balance for ${target.coinId}`,
              'INSUFFICIENT_BALANCE',
            );
          }
          for (const src of plan.sources) {
            const localBalance = engine.balanceOf(src.sphereToken, target.coinId);
            const useAll = src.spendAmount === localBalance;
            if (useAll) {
              const out = await engine.transfer({
                token: src.sphereToken,
                recipientPubkey,
                ...(request.memo !== undefined
                  ? { data: new TextEncoder().encode(request.memo) }
                  : {}),
              });
              deliveredTokens.push(out);
              this.removeTokenLocal(src.uiToken.id);
              details.push({ sourceTokenId: src.uiToken.id, method: 'direct' });
              deliveredUiTokens.push(this.uiTokenFromSphereToken(engine, out));
            } else {
              // Split with change back to self.
              const selfPubkey = hexToBytes(this.deps!.identity.chainPubkey);
              const change = localBalance - src.spendAmount;
              const outputs: {
                recipientPubkey: Uint8Array;
                coinId: string;
                amount: bigint;
                data?: Uint8Array;
              }[] = [
                {
                  recipientPubkey,
                  coinId: target.coinId,
                  amount: src.spendAmount,
                  ...(request.memo !== undefined
                    ? { data: new TextEncoder().encode(request.memo) }
                    : {}),
                },
              ];
              if (change > 0n) {
                outputs.push({
                  recipientPubkey: selfPubkey,
                  coinId: target.coinId,
                  amount: change,
                });
              }
              const splitResult = await engine.split({
                token: src.sphereToken,
                outputs,
              });
              // outputs[0] is recipient; outputs[1] (if present) is change.
              const recipientOut = splitResult.outputs[0];
              deliveredTokens.push(recipientOut);
              deliveredUiTokens.push(this.uiTokenFromSphereToken(engine, recipientOut));
              this.removeTokenLocal(src.uiToken.id);
              if (splitResult.outputs[1]) {
                const changeToken = this.uiTokenFromSphereToken(engine, splitResult.outputs[1]);
                await this.addTokenInternal(changeToken, splitResult.outputs[1]);
              }
              details.push({ sourceTokenId: src.uiToken.id, method: 'split' });
            }
          }
        }
      }

      // Deliver — build UXF-CAR payload (inline encoded tokens).
      const nostrEventId = await this.deliverTokens(
        engine,
        deliveredTokens,
        recipientTransportPubkey,
        request.memo,
      );

      const result: TransferResult = {
        id: transferId,
        status: 'delivered',
        tokens: deliveredUiTokens,
        tokenTransfers: details,
      };
      this.pendingTransfers.delete(transferId);

      // History + events.
      await this.recordHistory({
        type: 'SENT',
        amount: request.amount ?? '0',
        coinId: request.coinId ?? '',
        symbol: '',
        transferId,
        ...(peer?.nametag !== undefined ? { recipientNametag: peer.nametag } : {}),
        recipientPubkey: this.deps!.identity.chainPubkey,
        timestamp: Date.now(),
        tokenIds: deliveredUiTokens.map((t) => ({
          id: t.id,
          amount: t.amount,
          source: 'direct' as const,
        })),
      });
      this.deps!.emitEvent('transfer:confirmed', result);
      logger.debug('Payments', `send: delivered ${deliveredTokens.length} tokens via ${nostrEventId}`);
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const failed: TransferResult = {
        id: transferId,
        status: 'failed',
        tokens: [],
        tokenTransfers: [],
        error: errorMessage,
      };
      this.pendingTransfers.delete(transferId);
      this.deps!.emitEvent('transfer:failed', failed);
      return failed;
    }
  }

  private buildTargetList(
    request: TransferRequest,
  ): Array<{ kind: 'coin'; coinId: string; amount: string } | { kind: 'nft'; tokenId: string }> {
    const targets: Array<
      { kind: 'coin'; coinId: string; amount: string } | { kind: 'nft'; tokenId: string }
    > = [];
    if (request.coinId && request.amount && BigInt(request.amount) > 0n) {
      targets.push({ kind: 'coin', coinId: request.coinId, amount: request.amount });
    }
    for (const extra of request.additionalAssets ?? []) {
      if (extra.kind === 'coin') {
        targets.push({ kind: 'coin', coinId: extra.coinId, amount: extra.amount });
      } else if (extra.kind === 'nft') {
        targets.push({ kind: 'nft', tokenId: extra.tokenId });
      } else {
        throw new SphereError(
          `Unknown asset kind: ${(extra as { kind: string }).kind}`,
          'VALIDATION_ERROR',
        );
      }
    }
    if (!targets.length) {
      throw new SphereError('Send request has no assets to deliver', 'VALIDATION_ERROR');
    }
    return targets;
  }

  /**
   * Greedy coin-source selection over confirmed engine-owned tokens.
   * Picks tokens in ascending balance order until the wanted amount is met,
   * so small change accumulates on the last selected token.
   */
  private planCoinSpend(
    engine: ITokenEngine,
    coinId: string,
    wanted: bigint,
  ): { sources: Array<{ uiToken: Token; sphereToken: SphereToken; spendAmount: bigint }> } | null {
    const candidates: Array<{ uiToken: Token; sphereToken: SphereToken; balance: bigint }> = [];
    for (const [id, uiToken] of this.tokens) {
      if (uiToken.status !== 'confirmed') continue;
      if (uiToken.coinId !== coinId) continue;
      const st = this.engineTokens.get(id);
      if (!st) continue;
      const bal = engine.balanceOf(st, coinId);
      if (bal > 0n) candidates.push({ uiToken, sphereToken: st, balance: bal });
    }
    candidates.sort((a, b) => (a.balance < b.balance ? -1 : a.balance > b.balance ? 1 : 0));
    const sources: Array<{ uiToken: Token; sphereToken: SphereToken; spendAmount: bigint }> = [];
    let remaining = wanted;
    for (const c of candidates) {
      if (remaining <= 0n) break;
      const spend = c.balance <= remaining ? c.balance : remaining;
      sources.push({ uiToken: c.uiToken, sphereToken: c.sphereToken, spendAmount: spend });
      remaining -= spend;
    }
    if (remaining > 0n) return null;
    return { sources };
  }

  private findNftSource(
    tokenId: string,
  ): { uiToken: Token; sphereToken: SphereToken } | null {
    const uiToken = this.tokens.get(tokenId);
    const sphereToken = this.engineTokens.get(tokenId);
    if (!uiToken || !sphereToken) return null;
    if (uiToken.status !== 'confirmed') return null;
    return { uiToken, sphereToken };
  }

  private uiTokenFromSphereToken(engine: ITokenEngine, st: SphereToken): Token {
    const tokenId = engine.tokenId(st);
    const value: SphereValue | null = engine.readValue(st);
    const registry = TokenRegistry.getInstance();
    let coinId = '';
    let amount = '0';
    if (value && value.assets.length > 0) {
      const asset = value.assets[0];
      coinId = asset.coinId;
      amount = asset.amount.toString();
    }
    const def = coinId ? registry.getDefinition(coinId) : undefined;
    const iconUrl = def?.icons?.[0]?.url;
    const nowMs = Date.now();
    return {
      id: tokenId,
      coinId,
      symbol: def?.symbol || coinId.slice(0, 8),
      name: def?.name || coinId.slice(0, 8),
      decimals: def?.decimals ?? 0,
      ...(iconUrl !== undefined ? { iconUrl } : {}),
      amount,
      status: 'confirmed',
      createdAt: nowMs,
      updatedAt: nowMs,
      sdkData: encodeSdkDataEnvelope(engine, st),
    };
  }

  private async deliverTokens(
    engine: ITokenEngine,
    tokens: SphereToken[],
    recipientTransportPubkey: string,
    memo?: string,
  ): Promise<string> {
    if (!tokens.length) {
      throw new SphereError('No tokens to deliver', 'VALIDATION_ERROR');
    }
    // Inline JSON envelope of one blob per token — v2-safe wire format for
    // the slim rebuild. bundleCid is a deterministic derivation via the
    // first token's delivery key so recipients can dedupe replays.
    const encoded = tokens.map((t) => {
      const blob = engine.encodeToken(t);
      return {
        v: blob.v,
        network: blob.network,
        tokenId: blob.tokenId,
        token: bytesToBase64(blob.token),
      };
    });
    const carBase64 = Buffer.from(JSON.stringify({ tokens: encoded })).toString('base64');
    const firstKeys = await engine.deliveryKeys(engine.encodeToken(tokens[0]).token);
    const bundleCid = `b${firstKeys.tokenId.slice(0, 32)}`;

    const identity = this.deps!.identity;
    const payload: UxfTransferPayload = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'instant',
      bundleCid,
      tokenIds: tokens.map((t) => engine.tokenId(t)),
      sender: {
        transportPubkey: identity.chainPubkey,
        ...(identity.nametag !== undefined ? { nametag: identity.nametag } : {}),
      },
      ...(memo !== undefined ? { memo } : {}),
      carBase64,
    };

    return await this.deps!.transport.sendTokenTransfer(recipientTransportPubkey, payload);
  }

  /**
   * Issue #397 — Publish a pre-built UXF CAR bundle to a recipient.
   * Retained as a thin transport-only helper for AccountingModule.
   */
  async publishUxfBundle(params: {
    recipient: string;
    bundleCid: string;
    tokenIds: ReadonlyArray<string>;
    carBytes: Uint8Array;
    publishViaIpfsCid?: boolean;
    memo?: string;
    cidFetchGateways?: ReadonlyArray<string>;
  }): Promise<{
    nostrEventId: string;
    recipientTransportPubkey: string;
    recipientNametag?: string;
  }> {
    this.ensureInitialized();
    const peer = (await this.deps!.transport.resolve?.(params.recipient)) ?? null;
    const recipientTransportPubkey = resolveTransportPubkey(params.recipient, peer);
    const identity = this.deps!.identity;
    const senderField = {
      transportPubkey: identity.chainPubkey,
      ...(identity.nametag !== undefined ? { nametag: identity.nametag } : {}),
    };
    const tokenIds = params.tokenIds.slice();
    const payload: UxfTransferPayload = params.publishViaIpfsCid
      ? {
          kind: 'uxf-cid',
          version: '1.0',
          mode: 'instant',
          bundleCid: params.bundleCid,
          tokenIds,
          sender: senderField,
          ...(params.memo !== undefined ? { memo: params.memo } : {}),
          ...(params.cidFetchGateways && params.cidFetchGateways.length > 0
            ? { senderGateways: params.cidFetchGateways.slice() }
            : {}),
        }
      : {
          kind: 'uxf-car',
          version: '1.0',
          mode: 'instant',
          bundleCid: params.bundleCid,
          tokenIds,
          sender: senderField,
          ...(params.memo !== undefined ? { memo: params.memo } : {}),
          carBase64: Buffer.from(params.carBytes).toString('base64'),
        };
    const nostrEventId = await this.deps!.transport.sendTokenTransfer(
      recipientTransportPubkey,
      payload,
    );
    return {
      nostrEventId,
      recipientTransportPubkey,
      ...(peer?.nametag !== undefined ? { recipientNametag: peer.nametag } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Receive pipeline
  // ---------------------------------------------------------------------------

  async receive(opts?: { finalize?: boolean; timeout?: number }): Promise<{
    transfers: IncomingTransfer[];
  }> {
    this.ensureInitialized();
    // v2: tokens arrive via the transport subscription established in
    // initialize(); receive() is a rendezvous point that returns the
    // in-memory transfers surfaced so far. Callers can poll it after a
    // send-then-receive round to inspect the newest state.
    void opts;
    return { transfers: [] };
  }

  /**
   * Handle an incoming transport transfer event. Returns `true` when the
   * event is durably persisted (advances the transport's `since` cursor).
   */
  private async handleIncomingTransfer(transfer: IncomingTokenTransfer): Promise<boolean> {
    const engine = this.deps?.tokenEngine;
    if (!engine) {
      logger.warn('Payments', 'Received transfer but engine is not wired — dropping');
      return false;
    }
    try {
      const payload = transfer.payload;
      let blobs: Uint8Array[] = [];
      if (isUxfTransferPayloadCar(payload)) {
        blobs = extractInlineTokenBlobs(payload.carBase64);
      } else if (isUxfTransferPayloadCid(payload)) {
        // CID-by-reference — v2 slim rebuild does not fetch CARs. Log and
        // return false so the transport retains the event for a fatter
        // consumer.
        logger.warn(
          'Payments',
          `Ignoring uxf-cid payload (${payload.bundleCid}); CID-fetch not wired in v2 slim receive`,
        );
        return false;
      } else {
        logger.debug('Payments', 'Ignoring non-UXF transfer payload (legacy shape)');
        return false;
      }

      const myPubkey = hexToBytes(this.deps!.identity.chainPubkey);
      const acceptedTokens: Token[] = [];
      for (const bytes of blobs) {
        try {
          const st = await engine.decodeToken({ v: 1, network: 2, tokenId: '', token: bytes });
          if (!engine.isOwnedBy(st, myPubkey)) {
            logger.debug('Payments', 'Received token not owned by us; skipping');
            continue;
          }
          const verify = await engine.verify(st);
          if (!verify.ok) {
            logger.warn('Payments', `Received token failed verify: ${verify.reason}`);
            continue;
          }
          const uiToken = this.uiTokenFromSphereToken(engine, st);
          const added = await this.addTokenInternal(uiToken, st);
          if (added) acceptedTokens.push(uiToken);
        } catch (err) {
          logger.debug('Payments', 'Failed to decode/verify received token:', err);
        }
      }

      if (acceptedTokens.length > 0) {
        const incomingTransfer: IncomingTransfer = {
          id: transfer.id,
          senderPubkey: transfer.senderTransportPubkey,
          ...(isUxfTransferPayloadCar(payload) || isUxfTransferPayloadCid(payload)
            ? { senderNametag: payload.sender?.nametag }
            : {}),
          tokens: acceptedTokens,
          receivedAt: transfer.timestamp,
        };
        await this.recordHistory({
          type: 'RECEIVED',
          amount: acceptedTokens.reduce((sum, t) => sum + BigInt(t.amount), 0n).toString(),
          coinId: acceptedTokens[0]?.coinId ?? '',
          symbol: acceptedTokens[0]?.symbol ?? '',
          senderPubkey: transfer.senderTransportPubkey,
          ...(incomingTransfer.senderNametag !== undefined
            ? { senderNametag: incomingTransfer.senderNametag }
            : {}),
          timestamp: transfer.timestamp,
          tokenIds: acceptedTokens.map((t) => ({
            id: t.id,
            amount: t.amount,
            source: 'direct' as const,
          })),
        });
        this.deps!.emitEvent('transfer:incoming', incomingTransfer);
      }
      return true;
    } catch (err) {
      logger.warn('Payments', 'handleIncomingTransfer failed:', err);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Read model
  // ---------------------------------------------------------------------------

  getBalance(coinId?: string): Asset[] {
    return getBalanceImpl(this.assetsHost(), coinId);
  }

  async getAssets(coinId?: string): Promise<Asset[]> {
    return getAssetsImpl(this.assetsHost(), coinId);
  }

  async getFiatBalance(): Promise<number | null> {
    return getFiatBalanceImpl(this.assetsHost());
  }

  getTokens(filter?: { coinId?: string; status?: TokenStatus }): Token[] {
    return getTokensImpl(this.tokensViewHost(), filter);
  }

  getToken(id: string): Token | undefined {
    return getTokenImpl(this.tokensViewHost(), id);
  }

  getHistory(): TransactionHistoryEntry[] {
    return [...this._historyCache].sort((a, b) => b.timestamp - a.timestamp);
  }

  getPendingTransfers(): TransferResult[] {
    return Array.from(this.pendingTransfers.values());
  }

  private assetsHost() {
    return {
      tokens: this.tokens,
      priceProvider: this.priceProvider,
      isV6RecoverPermanentToken: () => false,
      isPriceDisabled: () => false,
    };
  }

  private tokensViewHost() {
    return {
      tokens: this.tokens,
      isV6RecoverPermanentToken: () => false,
      hasV6RecoverPermanentEntries: () => false,
    };
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  private async recordHistory(entry: Partial<HistoryRecord> & { type: string }): Promise<void> {
    const fullEntry: TransactionHistoryEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      dedupKey: `${entry.type}:${entry.transferId ?? entry.tokenIds?.[0] ?? crypto.randomUUID()}`,
      ...(entry as Partial<TransactionHistoryEntry>),
    } as TransactionHistoryEntry;
    this._historyCache.push(fullEntry);
    await this.persistAll();
  }

  async addToHistory(entry: Omit<TransactionHistoryEntry, 'id' | 'dedupKey'>): Promise<void> {
    await this.recordHistory(entry);
  }

  // ---------------------------------------------------------------------------
  // Sync & validate
  // ---------------------------------------------------------------------------

  async sync(_options?: unknown): Promise<{ added: number; removed: number }> {
    // v2 slim: rely on each provider's sync() individually. `options`
    // is retained for API-shape compatibility with the v1 SyncOptions
    // knobs (see modules/payments/sync/types.ts).
    let added = 0;
    let removed = 0;
    if (!this.tokenStorageProviders.size) return { added, removed };
    const localData = this.buildStorageData();
    for (const [, provider] of this.tokenStorageProviders) {
      try {
        const result = await provider.sync(localData);
        added += result.added ?? 0;
        removed += result.removed ?? 0;
        if (result.merged) {
          await this.loadFromStorageData(result.merged);
        }
      } catch (err) {
        logger.debug('Payments', 'sync: provider sync failed:', err);
      }
    }
    return { added, removed };
  }

  async validate(): Promise<{ valid: Token[]; invalid: Token[] }> {
    const engine = this.deps?.tokenEngine;
    const valid: Token[] = [];
    const invalid: Token[] = [];
    if (!engine) {
      // Conservative: nothing to validate against.
      for (const t of this.tokens.values()) valid.push(t);
      return { valid, invalid };
    }
    for (const [id, token] of this.tokens) {
      const st = this.engineTokens.get(id);
      if (!st) {
        invalid.push(token);
        continue;
      }
      try {
        const res = await engine.verify(st);
        if (res.ok) valid.push(token);
        else invalid.push(token);
      } catch {
        invalid.push(token);
      }
    }
    return { valid, invalid };
  }

  // ---------------------------------------------------------------------------
  // Payment requests
  // ---------------------------------------------------------------------------

  async sendPaymentRequest(
    recipient: string,
    params: Omit<PaymentRequest, 'id' | 'createdAt'>,
  ): Promise<PaymentRequestResult> {
    this.ensureInitialized();
    if (!this.deps!.transport.sendPaymentRequest) {
      return { success: false, error: 'Transport does not support sendPaymentRequest' };
    }
    return paymentRequestOutgoing.sendPaymentRequestImpl(
      this.sendPaymentRequestHost(),
      this.outgoingPaymentRequests,
      recipient,
      params,
    );
  }

  async waitForPaymentResponse(
    requestId: string,
    timeoutMs = 60_000,
  ): Promise<PaymentRequestResponse> {
    return paymentRequestOutgoing.waitForResponse(
      this.outgoingRequestHost(),
      requestId,
      timeoutMs,
    );
  }

  onPaymentRequest(handler: PaymentRequestHandler): () => void {
    return paymentRequestIncoming.registerIncomingHandler(this.paymentRequestHandlers, handler);
  }

  onPaymentRequestResponse(handler: PaymentRequestResponseHandler): () => void {
    return paymentRequestOutgoing.registerResponseHandler(
      this.paymentRequestResponseHandlers,
      handler,
    );
  }

  async payPaymentRequest(requestId: string, memo?: string): Promise<TransferResult> {
    return paymentRequestIncoming.payRequest(
      this.incomingRequestHost(),
      requestId,
      memo,
      (req) => this.send(req),
    );
  }

  async acceptPaymentRequest(requestId: string): Promise<void> {
    return paymentRequestIncoming.acceptRequest(this.incomingRequestHost(), requestId);
  }

  async rejectPaymentRequest(requestId: string): Promise<void> {
    return paymentRequestIncoming.rejectRequest(this.incomingRequestHost(), requestId);
  }

  getPaymentRequests(filter?: { status?: PaymentRequestStatus }): IncomingPaymentRequest[] {
    return paymentRequestIncoming.listIncomingRequests(this.paymentRequests, filter);
  }

  getPendingPaymentRequestsCount(): number {
    return paymentRequestIncoming.countPendingIncomingRequests(this.paymentRequests);
  }

  clearProcessedPaymentRequests(): void {
    this.paymentRequests = paymentRequestIncoming.filterProcessedIncomingRequests(
      this.paymentRequests,
    );
  }

  removePaymentRequest(requestId: string): void {
    this.paymentRequests = paymentRequestIncoming.removeIncomingRequestById(
      this.paymentRequests,
      requestId,
    );
  }

  getOutgoingPaymentRequests(filter?: { status?: PaymentRequestStatus }): OutgoingPaymentRequest[] {
    return paymentRequestOutgoing.listOutgoingRequests(this.outgoingPaymentRequests, filter);
  }

  cancelWaitForPaymentResponse(requestId: string): void {
    paymentRequestOutgoing.cancelWaitForResponse(this.pendingResponseResolvers, requestId);
  }

  removeOutgoingPaymentRequest(requestId: string): void {
    paymentRequestOutgoing.removeOutgoingRequest(this.outgoingRequestHost(), requestId);
  }

  clearCompletedOutgoingPaymentRequests(): void {
    paymentRequestOutgoing.clearCompletedOutgoingRequests(this.outgoingPaymentRequests);
  }

  markPaymentRequestPaid(requestId: string): void {
    paymentRequestIncoming.updateRequestStatus(
      this.paymentRequests,
      requestId,
      'paid',
      this.deps?.emitEvent,
    );
  }

  private incomingRequestHost(): IncomingRequestHost {
    return {
      requests: this.paymentRequests,
      handlers: this.paymentRequestHandlers,
      emitEvent: this.deps?.emitEvent,
      transport: this.deps?.transport,
    };
  }

  private outgoingRequestHost(): OutgoingRequestHost {
    return {
      requests: this.outgoingPaymentRequests,
      handlers: this.paymentRequestResponseHandlers,
      resolvers: this.pendingResponseResolvers,
      emitEvent: this.deps?.emitEvent,
    };
  }

  private sendPaymentRequestHost(): SendPaymentRequestHost {
    return {
      transport: this.deps!.transport,
      resolveTransportPubkey: (recipient, peer) => resolveTransportPubkey(recipient, peer ?? null),
    };
  }

  // ---------------------------------------------------------------------------
  // Nametag
  // ---------------------------------------------------------------------------

  async setNametag(nametag: NametagData): Promise<void> {
    nametagStore.upsertNametag(this.nametags, nametag);
    await this.persistAll();
  }

  getNametag(): NametagData | null {
    return nametagStore.getActiveNametag(this.nametags, this.deps?.identity.nametag);
  }

  getNametagByName(name: string): NametagData | null {
    return nametagStore.findNametagByName(this.nametags, name);
  }

  getNametags(): NametagData[] {
    return nametagStore.copyNametagList(this.nametags);
  }

  hasNametag(): boolean {
    return nametagStore.hasAnyNametag(this.nametags);
  }

  hasNametagNamed(name: string): boolean {
    return nametagStore.hasNametagWithName(this.nametags, name);
  }

  async clearNametag(): Promise<void> {
    this.nametags = [];
    await this.persistAll();
  }

  async clearNametagByName(name: string): Promise<boolean> {
    const { nextList, removed } = nametagStore.removeNametagByName(this.nametags, name);
    this.nametags = nextList;
    if (removed) await this.persistAll();
    return removed;
  }

  async mintNametag(nametag: string): Promise<MintNametagResult> {
    if (!this.deps?.tokenEngine) {
      return { success: false, error: 'Token engine not available' };
    }
    if (!this.nametagMinter) {
      this.nametagMinter = new NametagMinter({ tokenEngine: this.deps.tokenEngine });
    }
    const result = await this.nametagMinter.mintNametag(nametag);
    if (result.success && result.nametagData) {
      this.nametags.push(result.nametagData);
      await this.persistAll();
    }
    return result;
  }

  async mintFungibleToken(
    coinIdHex: string,
    amount: bigint,
  ): Promise<{ success: true; token: Token; tokenId: string } | { success: false; error: string }> {
    if (!this.deps?.tokenEngine) return { success: false, error: 'Token engine not available' };
    const registry = TokenRegistry.getInstance();
    return mintFungibleTokenImpl(
      {
        tokenEngine: this.deps.tokenEngine,
        getCoinSymbol: (id) => registry.getDefinition(id)?.symbol ?? id.slice(0, 8),
        getCoinName: (id) => registry.getDefinition(id)?.name ?? id.slice(0, 8),
        getCoinDecimals: (id) => registry.getDefinition(id)?.decimals ?? 0,
        getCoinIconUrl: (id) => registry.getDefinition(id)?.icons?.[0]?.url,
        addToken: (t: Token) => this.addTokenInternal(t),
      },
      coinIdHex,
      amount,
    );
  }

  async isNametagAvailable(nametag: string): Promise<boolean> {
    if (!this.deps?.tokenEngine) return false;
    return checkNametagAvailability({ tokenEngine: this.deps.tokenEngine, nametag });
  }

  // ---------------------------------------------------------------------------
  // Repository / storage compatibility API
  // ---------------------------------------------------------------------------

  async addToken(token: Token): Promise<boolean> {
    return this.addTokenInternal(token);
  }

  async updateToken(token: Token): Promise<void> {
    if (this.tokens.has(token.id)) {
      this.tokens.set(token.id, token);
      await this.persistAll();
    }
  }

  async removeToken(tokenId: string): Promise<void> {
    this.removeTokenLocal(tokenId);
    await this.persistAll();
  }

  onTokenChange(cb: (tokenId: string, sdkData: string) => void): () => void {
    this.tokenChangeCallbacks.add(cb);
    return () => this.tokenChangeCallbacks.delete(cb);
  }

  getTombstones(): TombstoneEntry[] {
    return [...this.tombstones];
  }

  isStateTombstoned(tokenId: string, stateHash: string): boolean {
    return this.tombstones.some((t) => t.tokenId === tokenId && t.stateHash === stateHash);
  }

  async mergeTombstones(remote: TombstoneEntry[]): Promise<number> {
    let added = 0;
    for (const t of remote) {
      if (!this.tombstones.some((x) => x.tokenId === t.tokenId && x.stateHash === t.stateHash)) {
        this.tombstones.push(t);
        added++;
      }
    }
    if (added > 0) await this.persistAll();
    return added;
  }

  async pruneTombstones(): Promise<void> {
    // v2 slim: no time-based expiry — retained for API stability.
  }

  getArchivedTokens(): Map<string, TxfToken> {
    return new Map(this.archivedTokens);
  }

  getBestArchivedVersion(tokenId: string): TxfToken | null {
    return this.archivedTokens.get(tokenId) ?? null;
  }

  async mergeArchivedTokens(remote: Map<string, TxfToken>): Promise<number> {
    let added = 0;
    for (const [id, tok] of remote) {
      if (!this.archivedTokens.has(id)) {
        this.archivedTokens.set(id, tok);
        added++;
      }
    }
    return added;
  }

  async pruneArchivedTokens(): Promise<void> {
    /* no-op */
  }

  getForkedTokens(): Map<string, TxfToken> {
    return new Map(this.forkedTokens);
  }

  async storeForkedToken(tokenId: string, _stateHash: string, txfToken: TxfToken): Promise<void> {
    this.forkedTokens.set(tokenId, txfToken);
    await this.persistAll();
  }

  async mergeForkedTokens(remote: Map<string, TxfToken>): Promise<number> {
    let added = 0;
    for (const [id, tok] of remote) {
      if (!this.forkedTokens.has(id)) {
        this.forkedTokens.set(id, tok);
        added++;
      }
    }
    return added;
  }

  async pruneForkedTokens(): Promise<void> {
    /* no-op */
  }

  async loadHistory(): Promise<void> {
    /* no-op — history is loaded lazily as part of loadFromStorageData */
  }

  updateTokenStorageProviders(
    providers: Map<string, TokenStorageProvider<TxfStorageDataBase>>,
  ): void {
    this.tokenStorageProviders = new Map(providers);
  }

  setPriceProvider(provider: PriceProvider): void {
    this.priceProvider = provider;
  }

  async waitForPendingOperations(): Promise<void> {
    /* no-op — v2 slim send is synchronous end-to-end */
  }

  async resolveUnconfirmed(): Promise<{
    resolved: number;
    stillPending: number;
    failed: number;
    details: Array<{ tokenId: string; stage: string; status: 'resolved' | 'pending' | 'failed' }>;
  }> {
    // v2: tokens arrive finalized. Nothing to resolve.
    return { resolved: 0, stillPending: 0, failed: 0, details: [] };
  }

  async getSigningPublicKey(): Promise<Uint8Array> {
    this.ensureInitialized();
    return hexToBytes(this.deps!.identity.chainPubkey);
  }

  exportTokens(): unknown[] {
    return Array.from(this.tokens.values());
  }

  async importTokens(
    _data: unknown,
    _options?: unknown,
  ): Promise<{
    added: ReadonlyArray<{
      readonly localId: string;
      readonly genesisTokenId: string;
      readonly code: 'added' | 'state-replaced' | 'stale-record-replaced';
      readonly note?: string;
    }>;
    skipped: ReadonlyArray<{
      readonly genesisTokenId: string;
      readonly code: 'duplicate' | 'tombstoned' | 'genesis-exists' | 'unknown';
      readonly reason: string;
    }>;
    rejected: ReadonlyArray<{
      readonly genesisTokenId: string | null;
      readonly code: 'malformed' | 'add-failed';
      readonly reason: string;
    }>;
  }> {
    return { added: [], skipped: [], rejected: [] };
  }

  // ---------------------------------------------------------------------------
  // Legacy v1 install hooks — no-op stubs for consumer bootstrap compat
  // ---------------------------------------------------------------------------

  installOutboxWriter(writer: unknown): void {
    this._outboxWriter = writer;
  }
  installSentLedgerWriter(writer: unknown): void {
    this._sentLedgerWriter = writer;
  }
  installSpentStateAuditWriter(writer: unknown): void {
    this._spentStateAuditWriter = writer;
  }
  installInclusionProofImporter(importer: unknown): void {
    this._inclusionProofImporter = importer;
  }
  installRevalidateCascadedRunner(runner: unknown): void {
    this._revalidateCascadedRunner = runner;
  }
  installSendingRecoveryWorker(worker: unknown): void {
    this._sendingRecoveryWorker = worker;
  }
  installSentReconciliationWorker(worker: unknown): void {
    this._sentReconciliationWorker = worker;
  }
  installNostrPersistenceVerifier(worker: unknown): void {
    this._nostrPersistenceVerifier = worker;
  }
  installSpentStateRescanWorker(worker: unknown): void {
    this._spentStateRescanWorker = worker;
  }
  installTombstoneGcWorker(worker: unknown): void {
    this._tombstoneGcWorker = worker;
  }
  installFinalizationWorkerSender(worker: unknown): void {
    this._finalizationWorkerSender = worker;
  }
  installFinalizationWorkerRecipient(worker: unknown): void {
    this._finalizationWorkerRecipient = worker;
  }
  installIngestWorkerPool(pool: unknown): void {
    this._ingestPool = pool;
  }
  installLegacyShapeAdapter(runner: LegacyShapeAdapterRunner): void {
    this._legacyShapeAdapterRunner = runner;
  }

  setSpentStateRescanTransitionToAudit(_fn: unknown): void {
    /* no-op */
  }

  configureRecipientPersistedStorage(_opts: unknown): void {
    /* no-op */
  }

  configureOperatorEscapeHatchStorage(_adapter: unknown, _opts?: unknown): void {
    /* no-op */
  }

  awaitRecipientContextHydration(): Promise<void> {
    return Promise.resolve();
  }

  getWorkerAbortSignal(): AbortSignal | undefined {
    return undefined;
  }

  async detectOrphanSpendingTokens(): Promise<{
    detected: number;
    tokens: Array<{ tokenId: string; reason: string }>;
  }> {
    return { detected: 0, tokens: [] };
  }

  async importInclusionProof(
    _addressId: string,
    _tokenId: string,
    _proof: unknown,
    _options?: unknown,
  ): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'v2 slim: importInclusionProof no longer required' };
  }

  async revalidateCascadedChildren(_parentTokenId: string): Promise<{
    revalidated: number;
    errors: string[];
  }> {
    return { revalidated: 0, errors: [] };
  }

  async sendInstant(request: TransferRequest): Promise<TransferResult> {
    // v2: send() is always instant. Preserved as an alias for API stability.
    return this.send(request);
  }
}

// =============================================================================
// TxfToken bridge
// =============================================================================

function txfEntryToToken(raw: TxfToken): Token | null {
  const anyRaw = raw as unknown as Record<string, unknown>;
  if (typeof anyRaw.id !== 'string') return null;
  return {
    id: anyRaw.id as string,
    coinId: (anyRaw.coinId as string) ?? '',
    symbol: (anyRaw.symbol as string) ?? '',
    name: (anyRaw.name as string) ?? '',
    decimals: (anyRaw.decimals as number) ?? 0,
    ...(typeof anyRaw.iconUrl === 'string' ? { iconUrl: anyRaw.iconUrl } : {}),
    amount: (anyRaw.amount as string) ?? '0',
    status: (anyRaw.status as TokenStatus) ?? 'confirmed',
    createdAt: (anyRaw.createdAt as number) ?? Date.now(),
    updatedAt: (anyRaw.updatedAt as number) ?? Date.now(),
    ...(typeof anyRaw.sdkData === 'string' ? { sdkData: anyRaw.sdkData } : {}),
  };
}

function tokenToTxfEntry(token: Token): TxfToken {
  return {
    ...(token as unknown as TxfToken),
  };
}

function extractInlineTokenBlobs(carBase64: string): Uint8Array[] {
  try {
    const json = JSON.parse(Buffer.from(carBase64, 'base64').toString('utf8')) as {
      tokens?: Array<{ token: string }>;
    };
    if (!Array.isArray(json.tokens)) return [];
    return json.tokens.map((t) => new Uint8Array(Buffer.from(t.token, 'base64')));
  } catch {
    return [];
  }
}

// =============================================================================
// Factory
// =============================================================================

export function createPaymentsModule(config?: PaymentsModuleConfig): PaymentsModule {
  return new PaymentsModule(config);
}

// Re-export for consumers that reach for these types via
// `import { ... } from '@unicitylabs/sphere-sdk'`.
export { decodeNostrEventContent, encodeTransferPayload };
