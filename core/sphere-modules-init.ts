/**
 * Sphere module initialization orchestration — Wave 6-P2-8d extraction
 * from `core/Sphere.ts`.
 *
 * Owns the cross-module wire-up that sits between the wallet key
 * material and every feature module (PaymentsModule, AccountingModule,
 * SwapModule, CommunicationsModule, GroupChatModule, MarketModule).
 * Five orchestrations moved here:
 *
 *   1. {@link initializeModulesImpl} — primary-address bootstrap. Runs
 *      once from `create()` / `load()` / `import()` after providers +
 *      identity are wired. Threads the tokenEngine, per-wallet CID-ref
 *      store, IPFS publisher, transport mux, and Profile-backed durable
 *      writers into every enabled module, then loads them in a specific
 *      order (payments critical + serial, others parallel best-effort),
 *      registers the module set in {@link ModulesInitHost._addressModules},
 *      constructs the {@link ConnectivityManager}, and arms both the
 *      outer transport's and (if present) the mux's subscription gates.
 *
 *   2. {@link initializeAddressModulesImpl} — per-address bootstrap
 *      called from `switchToAddress` for non-primary addresses. Same
 *      wiring recipe as {@link initializeModulesImpl} but produces a
 *      fresh {@link AddressModuleSet} rather than mutating the wallet's
 *      active module references. Coordinates mux suppression /
 *      re-arm around the address hop so the relay doesn't stream
 *      TOKEN_TRANSFER events into freshly-created adapters whose
 *      handlers haven't registered yet (#442).
 *
 *   3. {@link wireProfilePersistedSendStorageImpl} — Issue #97
 *      atomic install of the OutboxWriter + SentLedgerWriter pair onto
 *      a PaymentsModule. Both must install together (dispatcher
 *      dual-writes through both), or neither installs (falling back to
 *      the legacy KV outbox). Shared between {@link initializeModulesImpl}
 *      (primary path) and {@link initializeAddressModulesImpl}
 *      (per-address path).
 *
 *   4. {@link buildCidRefStoreOrNullImpl} — Issue #285. Constructs the
 *      per-wallet CID-ref store when the StorageProvider is a
 *      ProfileStorageProvider with encryption + IPFS gateways wired.
 *      Otherwise returns null and the fat-data write sites fall back to
 *      inline JSON (bounded by the 128 KiB OpLog cap).
 *
 *   5. {@link ensureTransportMuxImpl} — lazy-init of the multi-address
 *      transport mux. Called on the primary address bootstrap and on
 *      every subsequent `switchToAddress`. Idempotent — creates the mux
 *      exactly once, then just registers the new address as a mux port.
 *      Includes the #442 pre-connect suppression so the relay
 *      subscription doesn't open before every module has registered its
 *      handlers.
 *
 * Behavior-preserving: bodies moved verbatim behind the
 * {@link ModulesInitHost} shim. Every JSDoc paragraph, every inline
 * comment, every eslint-disable-next-line, every `await` — including
 * the wave 6-P2-4e `await host.ensureTokenEngine()` calls and the three
 * `payments.initialize({ ..., tokenEngine: host._tokenEngine ?? undefined })`
 * / two `accounting.initialize({ ..., tokenEngine: host._tokenEngine ?? undefined })`
 * sites — reproduces exactly. Sphere.ts retains thin private
 * delegators so the existing callsites (public `switchToAddress`, the
 * `sphere.initializeModules()` calls inside `create()` / `load()` /
 * `import()`, and the reciprocal delegators on `AddressHost`) continue
 * to work unchanged.
 */

import { logger } from './logger';
import type { FullIdentity, SphereEventType, SphereEventMap, SphereEventHandler } from '../types';
import type {
  StorageProvider,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../storage';
import type { TransportProvider } from '../transport';
import {
  MultiAddressTransportMux,
  AddressTransportAdapter,
} from '../transport/MultiAddressTransportMux';
import type { OracleProvider } from '../oracle';
import type { PriceProvider } from '../price';
import {
  PaymentsModule,
  createPaymentsModule,
} from '../modules/payments';
import {
  CommunicationsModule,
  createCommunicationsModule,
} from '../modules/communications';
import type { CommunicationsModuleConfig } from '../modules/communications';
import {
  GroupChatModule,
  createGroupChatModule,
} from '../modules/groupchat';
import type { GroupChatModuleConfig } from '../modules/groupchat';
import {
  MarketModule,
  createMarketModule,
} from '../modules/market';
import type { MarketModuleConfig } from '../modules/market';
import type { AccountingModule } from '../modules/accounting';
import type { SwapModule } from '../modules/swap/index.js';
import type { ITokenEngine } from '../token-engine';
import type { PublishToIpfsCallback } from '../extensions/uxf/pipeline/delivery-resolver';
import type { AddressInfo, MasterKey } from './crypto';
import type { TrackedAddress } from '../types';
import { getAddressId } from '../constants';
import { safeErrorMessage } from './error-sanitize';
import { ConnectivityManager } from './connectivity';
import type { AddressModuleSet } from './Sphere';

/** Mutable version of FullIdentity — matches Sphere's internal alias. */
type MutableFullIdentity = {
  -readonly [K in keyof FullIdentity]: FullIdentity[K];
};

/**
 * Host shim for module initialization orchestration. Mirrors the
 * Sphere-private state and helpers that the moved methods reach for.
 *
 * Several fields are mutable because the bootstrap rotates active
 * module references (payments / communications / groupChat / market),
 * lazily constructs the transport mux and connectivity manager, and
 * populates the per-address module map.
 */
export interface ModulesInitHost {
  // -- Wallet identity + address pointer (mutable — primary bootstrap
  //    reads `_identity` after providers+identity finalize; the module
  //    map is keyed by `_currentAddressIndex`).
  _identity: MutableFullIdentity | null;
  readonly _currentAddressIndex: number;
  readonly _masterKey: MasterKey | null;

  // -- Providers + shared state.
  readonly _storage: StorageProvider;
  readonly _transport: TransportProvider;
  readonly _oracle: OracleProvider;
  readonly _priceProvider: PriceProvider | null;
  readonly _publishToIpfs: PublishToIpfsCallback | null;
  readonly _cidFetchGateways: ReadonlyArray<string> | null;
  readonly _disabledProviders: Set<string>;
  readonly _dmSince: number | null;

  // -- Token engine (wave 6-P2-4e). `null` until first ensureTokenEngine()
  //    call resolves; the wire sites read the field AFTER awaiting the
  //    ensure hop so the engine is present when payments/accounting
  //    receive it in their initialize deps.
  readonly _tokenEngine: ITokenEngine | null;

  // -- Active module references (rotated by primary bootstrap).
  _payments: PaymentsModule;
  _communications: CommunicationsModule;
  _groupChat: GroupChatModule | null;
  _market: MarketModule | null;
  _accounting: AccountingModule | null;
  _swap: SwapModule | null;

  // -- Module configs consulted when spinning up per-address instances.
  readonly _communicationsConfig: CommunicationsModuleConfig | undefined;
  readonly _groupChatConfig: GroupChatModuleConfig | undefined;
  readonly _marketConfig: MarketModuleConfig | undefined;

  // -- Per-address wiring state.
  readonly _tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>>;
  readonly _addressModules: Map<number, AddressModuleSet>;
  _transportMux: MultiAddressTransportMux | null;

  // -- Connectivity manager (built lazily during primary bootstrap).
  _connectivity: ConnectivityManager | null;

  // -- Helpers still on the Sphere facade.
  emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
  on<T extends SphereEventType>(type: T, handler: SphereEventHandler<T>): () => void;
  ensureTokenEngine(): Promise<ITokenEngine | null>;
  buildConnectivityManager(): ConnectivityManager;
  _deriveAddressInternal(index: number, isChange?: boolean): AddressInfo;
  _getActiveAddressesInternal(): TrackedAddress[];
}

// =============================================================================
// Issue #174 — spent-state-rescan AUDIT DispositionWriter factory
// =============================================================================

/**
 * Build a {@link DispositionWriter} narrowed to the AUDIT collection
 * (`reason: 'off-record-spend'`, §5.3 [E] / §5.4) for the spent-state
 * rescan worker.
 *
 * Mirrors the module-scope helper in `core/Sphere.ts` so the two
 * `configureOperatorEscapeHatchStorage` wire sites in this file can
 * call it without re-crossing the facade. Kept as a free function
 * local to this file — its manifestStore stub is defense-in-depth
 * only, so a second copy is preferable to widening the host surface.
 */
async function buildSpentStateAuditWriter(
  adapter: import('../extensions/uxf/profile/disposition-storage-adapters').OrbitDbDispositionStorageAdapter,
  emitEvent: <T extends SphereEventType>(
    type: T,
    data: SphereEventMap[T],
  ) => void,
): Promise<import('../extensions/uxf/profile/disposition-writer').DispositionWriter> {
  const { DispositionWriter } = await import('../extensions/uxf/profile/disposition-writer');
  const { ManifestStore } = await import('../extensions/uxf/profile/manifest-store');
  const { Lamport } = await import('../extensions/uxf/profile/lamport');
  const { SphereError } = await import('./errors');
  const stubManifestStorage: import('../extensions/uxf/profile/manifest-cas').MinimalManifestStorage = {
    async readEntry(): Promise<never> {
      throw new SphereError(
        'spent-state-rescan AUDIT-only DispositionWriter: manifestStore.readEntry called — ' +
          'this writer is wired only for AUDIT records; non-AUDIT records must not be routed through it.',
        'VALIDATION_ERROR',
      );
    },
    async writeEntry(): Promise<never> {
      throw new SphereError(
        'spent-state-rescan AUDIT-only DispositionWriter: manifestStore.writeEntry called — ' +
          'this writer is wired only for AUDIT records; non-AUDIT records must not be routed through it.',
        'VALIDATION_ERROR',
      );
    },
  };
  const stubManifestStore = new ManifestStore({
    storage: stubManifestStorage,
    lamport: new Lamport(),
  });
  return new DispositionWriter({
    storage: adapter,
    manifestStore: stubManifestStore,
    emit: emitEvent,
  });
}

// =============================================================================
// Ensure Transport Mux
// =============================================================================

/**
 * Ensure the transport multiplexer exists and register an address.
 * Creates the mux on first call. Returns an AddressTransportAdapter
 * that routes events for this address independently.
 * @returns AddressTransportAdapter or null if transport is not Nostr-based
 */
export async function ensureTransportMuxImpl(
  host: ModulesInitHost,
  index: number,
  identity: FullIdentity,
): Promise<AddressTransportAdapter | null> {
  // Duck-type check for Nostr transport (instanceof won't work across tsup bundles)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transport = host._transport as any;
  if (typeof transport.getWebSocketFactory !== 'function' ||
      typeof transport.getConfiguredRelays !== 'function') {
    logger.debug('Sphere', 'Transport does not support mux interface, skipping');
    return null;
  }

  const nostrTransport = transport;

  // Create mux on first call
  if (!host._transportMux) {
    host._transportMux = new MultiAddressTransportMux({
      relays: nostrTransport.getConfiguredRelays(),
      createWebSocket: nostrTransport.getWebSocketFactory(),
      storage: nostrTransport.getStorageAdapter() ?? undefined,
      // #123: share the original transport's NostrClient instead of
      // opening a second WebSocket per relay. Pass a getter so the
      // Mux resolves it at connect-time (after the transport finishes
      // its own connect()).
      sharedNostrClient: typeof nostrTransport.getNostrClient === 'function'
        ? () => nostrTransport.getNostrClient()
        : undefined,
    });

    // Issue #442 — suppress mux subscriptions BEFORE connect so the
    // relay subscription is NOT opened until armSubscriptions() runs
    // after every module's `load()` returns. Without this, DMs replayed
    // by the relay between `mux.connect()` and `swap.load()` register
    // their `communications.onDirectMessage(...)` handler land in the
    // CommunicationsModule inbox (via the comms-owned onMessage handler
    // that DOES register early) but never reach SwapModule's
    // `swap_proposal:` parser — breaking cross-process swap flows
    // (sphere-sdk#437). Mirrors the #423 fix for the non-mux path.
    host._transportMux.suppressSubscriptions();

    // Connect the mux
    await host._transportMux.connect();

    // Suppress original transport's subscriptions to avoid duplicate event handling.
    // Original transport stays connected for resolve/identity-binding operations.
    if (typeof nostrTransport.suppressSubscriptions === 'function') {
      nostrTransport.suppressSubscriptions();
    }

    logger.debug('Sphere', 'Transport mux created and connected');
  }

  // Forward dmSince fallback to the mux for this address
  if (host._dmSince != null) {
    host._transportMux.setFallbackDmSince(index, host._dmSince);
  }

  // Register address in the mux (resolve delegated to original transport)
  const adapter = await host._transportMux.addAddress(index, identity, host._transport);
  return adapter;
}

// =============================================================================
// Build CID-Ref Store (Issue #285)
// =============================================================================

/**
 * Issue #285 — Construct a {@link CidRefStore} via the storage
 * provider's `buildCidRefStore()` helper when available.
 *
 * The four fat-data OpLog write sites
 * (`CommunicationsModule._doSave`, `GroupChatModule.persistMembers`,
 * `GroupChatModule.persistProcessedEvents`,
 * `GroupChatModule.persistMessages`) — plus `PaymentsModule` pending
 * V5 tokens and `AccountingModule` invoice ledger — accept an
 * optional CidRefStore via their `initialize()` deps. Without one,
 * each falls through to inline JSON storage which routinely exceeds
 * the 128 KiB Profile OpLog cap (3.98 MB observed for the
 * `announcements` group's `groupChatMembers` blob).
 *
 * Best-effort: when the storage provider is not a
 * `ProfileStorageProvider`, when encryption is disabled, when the
 * identity has not been set yet, or when no IPFS gateways are
 * configured, this returns `null` and the modules retain their
 * legacy inline behaviour (still bounded by the 128 KiB cap; the
 * existing PAYLOAD-SIZE soft-warn will fire on offending writes).
 *
 * The returned store is cached per-Sphere-instance. Identity
 * rotation (`load()` switching to a different address) MUST
 * `_cidRefStore = null` to force a rebuild — the captured
 * encryption key is the one at construction time.
 */
export function buildCidRefStoreOrNullImpl(
  host: ModulesInitHost,
): import('../extensions/uxf/profile/cid-ref-store').CidRefStore | null {
  try {
    const storageWithBuilder = host._storage as unknown as {
      buildCidRefStore?: () => import('../extensions/uxf/profile/cid-ref-store').CidRefStore | null;
    };
    if (typeof storageWithBuilder.buildCidRefStore !== 'function') {
      return null;
    }
    return storageWithBuilder.buildCidRefStore();
  } catch (err) {
    logger.warn(
      'Sphere',
      `buildCidRefStoreOrNull threw — modules fall back to inline JSON storage: ${safeErrorMessage(err)}`,
    );
    return null;
  }
}

// =============================================================================
// Wire Profile-persisted send storage (Issue #97)
// =============================================================================

/**
 * Issue #97 — Wire the profile-resident OutboxWriter + SentLedgerWriter
 * onto a PaymentsModule. Used by BOTH `initializeModules` (primary
 * address bootstrap) and `initializeAddressModules` (per-address
 * bootstrap on `switchToAddress`).
 *
 * **Atomicity (steelman C5 partial fix):** the OutboxWriter and
 * SentLedgerWriter MUST be installed together. PaymentsModule's
 * dispatcher hooks dual-write through both — installing OutboxWriter
 * alone would tombstone outbox entries on `delivered` with no
 * permanent SENT backup. To enforce this:
 *   - If either build returns null, install NEITHER. Falls back to
 *     legacy KV outbox.
 *   - Pre-check both before either install fires.
 *
 * **Best-effort:** when the storage provider is not a
 * `ProfileStorageProvider` (e.g. legacy IndexedDB), this is a no-op.
 *
 * @param payments  The PaymentsModule instance to wire.
 * @param identity  The full identity carrying the directAddress (used
 *                  to derive the addressId scope for both writers).
 */
export function wireProfilePersistedSendStorageImpl(
  host: ModulesInitHost,
  payments: PaymentsModule,
  identity: FullIdentity | null,
): void {
  if (identity === null) return;
  try {
    const storageForOutbox = host._storage as unknown as {
      buildOutboxWriter?: (
        addressId: string,
      ) => import('../extensions/uxf/profile/outbox-writer').OutboxWriter | null;
      buildSentLedgerWriter?: (
        addressId: string,
      ) => import('../extensions/uxf/profile/sent-ledger-writer').SentLedgerWriter | null;
    };
    if (
      typeof storageForOutbox.buildOutboxWriter !== 'function' ||
      typeof storageForOutbox.buildSentLedgerWriter !== 'function'
    ) {
      return;
    }
    const directAddress = identity.directAddress;
    if (typeof directAddress !== 'string' || directAddress.length === 0) {
      return;
    }
    const addressId = getAddressId(directAddress);

    // Pre-check both before installing either (atomicity).
    const outboxWriter = storageForOutbox.buildOutboxWriter(addressId);
    const sentWriter = storageForOutbox.buildSentLedgerWriter(addressId);
    if (outboxWriter === null || sentWriter === null) {
      if (outboxWriter !== null || sentWriter !== null) {
        logger.warn(
          'Sphere',
          `wireProfilePersistedSendStorage(${addressId}): partial build (outbox=${outboxWriter !== null} sent=${sentWriter !== null}) — refusing to install either (atomicity invariant); PaymentsModule will use legacy KV outbox`,
        );
      } else {
        logger.debug(
          'Sphere',
          `wireProfilePersistedSendStorage(${addressId}): builds returned null (encryption disabled or identity pending) — PaymentsModule uses legacy KV outbox`,
        );
      }
      return;
    }

    payments.installOutboxWriter(outboxWriter);
    payments.installSentLedgerWriter(sentWriter);
    logger.debug(
      'Sphere',
      `Wired profile-resident OutboxWriter + SentLedgerWriter for address ${addressId}`,
    );
  } catch (err) {
    logger.warn(
      'Sphere',
      `wireProfilePersistedSendStorage threw — PaymentsModule falls back to legacy KV outbox: ${safeErrorMessage(err)}`,
    );
  }
}

// =============================================================================
// Per-address module bootstrap
// =============================================================================

/**
 * Create a new set of per-address modules for the given index.
 * Each address gets its own PaymentsModule, CommunicationsModule, etc.
 * Modules are fully independent — they have their own token storage,
 * and can sync/finalize/split in background regardless of active address.
 *
 * @param index - HD address index
 * @param identity - Full identity for this address
 * @param tokenStorageProviders - Token storage providers for this address
 */
export async function initializeAddressModulesImpl(
  host: ModulesInitHost,
  index: number,
  identity: FullIdentity,
  tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>>,
): Promise<AddressModuleSet> {
  // Destroy swap before accounting — swap depends on accounting.
  if (host._swap) {
    await host._swap.destroy();
  }
  // W23 fix: Destroy the previous accounting module instance before re-init.
  // This drains in-flight gated operations (auto-return, implicit close) that
  // may hold stale ledger references from the previous address.
  if (host._accounting) {
    await host._accounting.destroy();
  }

  const emitEvent = host.emitEvent.bind(host);

  // Issue #442 — suppress the mux subscription BEFORE addAddress so the
  // relay filter is NOT rebuilt with the new pubkey until this address's
  // modules finish loading. The mux is already armed from the primary
  // address's `initializeModules()`, so without this hop the upcoming
  // `addAddress(...)` would auto-call `updateSubscriptions()` and the
  // relay would immediately start streaming events for the new pubkey
  // into adapters whose handlers haven't registered yet — same race as
  // the primary path. The primary address's existing wallet/chat sub
  // continues delivering through the suppression window (suppress is a
  // gate on FUTURE updates, not a tear-down).
  if (host._transportMux) {
    host._transportMux.suppressSubscriptions();
  }

  // Ensure transport mux exists for non-primary addresses
  const adapter = await ensureTransportMuxImpl(host, index, identity);

  // Use the adapter for transport-dependent modules (address-specific event routing)
  // Resolve operations are delegated to the original transport
  const addressTransport: TransportProvider = adapter ?? host._transport;

  // Forward dmSince to the raw transport when no mux is used
  if (!adapter && host._dmSince != null && addressTransport.setFallbackDmSince) {
    addressTransport.setFallbackDmSince(host._dmSince);
  }

  // Create fresh module instances for this address
  const payments = createPaymentsModule({});
  const communications = createCommunicationsModule(host._communicationsConfig);
  const groupChat = host._groupChatConfig ? createGroupChatModule(host._groupChatConfig) : null;
  const market = host._marketConfig ? createMarketModule(host._marketConfig) : null;

  // G3 + G7 — Wire Profile-backed persisted storage for the recipient
  // cross-restart safety net BEFORE payments.initialize() so the
  // auto-installed FinalizationWorkerRecipient picks up the persisted
  // FinalizationQueueStorage and the in-memory recipient context Maps
  // re-hydrate from the persisted contexts. The wiring is best-effort:
  // when the StorageProvider isn't a ProfileStorageProvider (e.g.
  // legacy IndexedDB), the auto-install falls back to in-memory shims
  // (legacy behavior — does NOT survive Sphere.destroy() / restart).
  try {
    const storageWithBuilders = host._storage as unknown as {
      buildFinalizationQueueStorageAdapter?: () =>
        | import('../extensions/uxf/profile/finalization-queue-storage-adapter').OrbitDbFinalizationQueueStorageAdapter
        | null;
      buildRecipientContextStorageAdapter?: () =>
        | import('../extensions/uxf/profile/finalization-queue-storage-adapter').OrbitDbRecipientContextStorageAdapter
        | null;
    };
    const queueAdapter =
      typeof storageWithBuilders.buildFinalizationQueueStorageAdapter === 'function'
        ? storageWithBuilders.buildFinalizationQueueStorageAdapter()
        : null;
    const ctxAdapter =
      typeof storageWithBuilders.buildRecipientContextStorageAdapter === 'function'
        ? storageWithBuilders.buildRecipientContextStorageAdapter()
        : null;
    if (queueAdapter !== null || ctxAdapter !== null) {
      payments.configureRecipientPersistedStorage({
        ...(queueAdapter !== null
          ? { finalizationQueueStorage: queueAdapter }
          : {}),
        ...(ctxAdapter !== null ? { recipientContextStorage: ctxAdapter } : {}),
      });
    }
  } catch (err) {
    logger.warn(
      'Sphere',
      `G3/G7: failed to wire Profile-backed recipient persisted storage (continuing with in-memory shims): ${safeErrorMessage(err)}`,
    );
  }

  // Issue #285 — per-address CidRefStore. Same null semantics as the
  // primary load() path (see buildCidRefStoreOrNull). All modules
  // sharing this storage provider use the same CidRefStore instance.
  const cidRefStore = buildCidRefStoreOrNullImpl(host);

  // Phase 6 — ensure v2 token engine before wiring into deps.
  await host.ensureTokenEngine();

  // Initialize with address-specific identity and per-address transport
  payments.initialize({
    identity,
    storage: host._storage,
    tokenStorageProviders,
    transport: addressTransport,
    oracle: host._oracle,
    tokenEngine: host._tokenEngine ?? undefined,
    emitEvent,
    price: host._priceProvider ?? undefined,
    // Issue #200 Phase 1 wiring — forward canonical UXF CAR publisher
    // to every per-address PaymentsModule (one closure shared across
    // all addresses; the publisher is identity-independent).
    publishToIpfs: host._publishToIpfs ?? undefined,
    cidFetchGateways: host._cidFetchGateways ?? undefined,
    // Issue #285 — CID-ref store for pending V5 token storage (fat-data).
    cidRefStore: cidRefStore ?? undefined,
    // Issue #255 Problem A — HD-index recovery hooks for
    // finalizeTransferToken. See initializeModules() above for full
    // rationale.
    ...(host._masterKey
      ? {
          deriveAddressInfo: (idx: number) =>
            host._deriveAddressInternal(idx, false),
          getActiveAddresses: () => host._getActiveAddressesInternal(),
        }
      : {}),
  });

  communications.initialize({
    identity,
    storage: host._storage,
    transport: addressTransport,
    emitEvent,
    // Issue #285 — CID-ref store for per-address DM cache.
    cidRefStore: cidRefStore ?? undefined,
  });

  groupChat?.initialize({
    identity,
    storage: host._storage,
    emitEvent,
    // Issue #285 — CID-ref store for group/member/messages/processedEvents.
    cidRefStore: cidRefStore ?? undefined,
  });

  market?.initialize({
    identity,
    emitEvent,
  });

  if (host._accounting) {
    const accountingTokenStorage = tokenStorageProviders.values().next().value;
    if (accountingTokenStorage) {
      // Resolve trustBase from oracle for invoice proof verification
      let trustBase: unknown = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        trustBase = (host._oracle as any).getTrustBase?.() ?? null;
      } catch {
        logger.warn('Sphere', 'Oracle does not support getTrustBase — invoice proof verification will be unavailable');
      }

      host._accounting.initialize({
        payments,
        tokenStorage: accountingTokenStorage,
        oracle: host._oracle,
        tokenEngine: host._tokenEngine ?? undefined,
        trustBase,
        identity,
        getActiveAddresses: () => host._getActiveAddressesInternal(),
        emitEvent,
        on: host.on.bind(host),
        storage: host._storage,
        communications,
        // Issue #285 — CID-ref store for invoice ledger.
        cidRefStore: cidRefStore ?? undefined,
      });
    } else {
      logger.warn('Sphere', 'Accounting module enabled but no token storage available — disabling');
      host._accounting = null;
    }
  }

  if (host._swap) {
    if (host._accounting) {
      const acctForSwap = host._accounting;
      const onForSwap = host.on.bind(host);
      host._swap.initialize({
        accounting: {
          importInvoice: (token: unknown) => acctForSwap.importInvoice(token as Parameters<typeof acctForSwap.importInvoice>[0]),
          getInvoice: (id: string) => acctForSwap.getInvoice(id),
          getInvoiceStatus: (id: string) => acctForSwap.getInvoiceStatus(id),
          payInvoice: (id: string, params: unknown) => acctForSwap.payInvoice(id, params as Parameters<typeof acctForSwap.payInvoice>[1]),
          getTokenIdsForInvoice: (id: string) => acctForSwap.getTokenIdsForInvoice(id),
          on: onForSwap,
        },
        payments: { getToken: (id: string) => payments.getToken(id) },
        oracle: {
          isSpent: (pk: string, sh: string) => host._oracle.isSpent(pk, sh),
          getRootTrustBase: () =>
            (host._oracle as { getRootTrustBase?: () => unknown | null }).getRootTrustBase?.() ?? null,
        },
        communications: {
          sendDM: async (recipientPubkey: string, content: string) => {
            const msg = await communications.sendDM(recipientPubkey, content);
            return { eventId: msg.id };
          },
          onDirectMessage: (handler) => communications.onDirectMessage(handler),
        },
        storage: host._storage,
        identity,
        emitEvent,
        resolve: (id) => host._transport.resolve?.(id) ?? Promise.resolve(null),
        getActiveAddresses: () => host._getActiveAddressesInternal(),
      });
    } else {
      logger.warn('Sphere', 'Swap module enabled but accounting module not available — disabling');
      host._swap = null;
    }
  }

  // Round 7 (FIX 1) / Round 8 (FIX 1) — Wire production OrbitDb-backed
  // disposition storage AND oracle.verifyInclusionProof into the
  // operator escape-hatch importer. Mirrors the wiring in
  // `initializeModules()` for the default-address path. See there
  // for full rationale + KNOWN LIMITATION docstring.
  //
  // Round 8 (FIX 2) — Without this hop, every non-default address
  // would silently retain the Round 7 fail-closed verifier stub even
  // when the wallet has a real oracle wired. That asymmetry meant a
  // multi-address wallet could pass operator probes on its primary
  // address but fail them on derived addresses.
  try {
    const storageWithBuilder = host._storage as unknown as {
      buildDispositionStorageAdapter?: () =>
        | import('../extensions/uxf/profile/disposition-storage-adapters').OrbitDbDispositionStorageAdapter
        | null;
    };
    const builderAvailable =
      typeof storageWithBuilder.buildDispositionStorageAdapter === 'function';
    const adapter = builderAvailable
      ? storageWithBuilder.buildDispositionStorageAdapter!()
      : null;

    // Round 8 (FIX 1) — verifyProof adapter (same shape as the
    // default-address path).
    const oracleForVerify = host._oracle as unknown as {
      verifyInclusionProof?: (input: {
        readonly proofJson: unknown;
        readonly transactionHash: string;
        readonly proofHash?: string;
      }) => Promise<boolean>;
    };
    const oracleHasVerify =
      typeof oracleForVerify.verifyInclusionProof === 'function';
    const verifyProofAdapter:
      | import('../extensions/uxf/pipeline/import-inclusion-proof').ProofVerifier
      | undefined = oracleHasVerify
      ? async (
          proof: import('../extensions/uxf/pipeline/import-inclusion-proof').ImportableInclusionProof,
        ): Promise<import('../extensions/uxf/pipeline/proof-verifier').ProofVerifyStatus> => {
          try {
            const ok = await oracleForVerify.verifyInclusionProof!({
              proofJson: proof.proof,
              transactionHash: proof.transactionHash,
            });
            return ok ? 'OK' : 'NOT_AUTHENTICATED';
          } catch {
            return 'NOT_AUTHENTICATED';
          }
        }
      : undefined;

    if (adapter !== null && adapter !== undefined) {
      payments.configureOperatorEscapeHatchStorage(
        adapter,
        verifyProofAdapter !== undefined
          ? { verifyProof: verifyProofAdapter }
          : undefined,
      );
      // Issue #174 (DispositionWriter wiring) — also wire the
      // spent-state-rescan AUDIT route. Re-uses the same OrbitDb
      // adapter so the `_audit` records the operator escape-hatch
      // imports already touch and the records the spent-state-rescan
      // worker writes both land in the SAME collection — single
      // source of truth per §5.4.
      try {
        const auditWriter = await buildSpentStateAuditWriter(adapter, emitEvent);
        payments.installSpentStateAuditWriter(auditWriter);
        logger.debug(
          'Sphere',
          `Wired spent-state-rescan AUDIT DispositionWriter for address ${index}`,
        );
      } catch (auditErr) {
        logger.warn(
          'Sphere',
          `Failed to wire spent-state-rescan AUDIT DispositionWriter for address ${index}: ${safeErrorMessage(auditErr)}`,
        );
      }
      logger.debug(
        'Sphere',
        `Wired OrbitDb-backed disposition storage + verifyProof for address ${index}`,
      );
    } else if (verifyProofAdapter !== undefined) {
      // No OrbitDb adapter, but we still have a real oracle —
      // upgrade just the verifier so multi-address wallets also
      // benefit from the Round 8 verifier wiring.
      const { InMemoryDispositionStorageAdapter } = await import(
        '../extensions/uxf/profile/disposition-storage-adapters'
      );
      payments.configureOperatorEscapeHatchStorage(
        new InMemoryDispositionStorageAdapter(),
        { verifyProof: verifyProofAdapter },
      );
      logger.debug(
        'Sphere',
        `Wired oracle.verifyInclusionProof for address ${index} (in-memory disposition storage)`,
      );
    }
  } catch (err) {
    logger.warn(
      'Sphere',
      `Failed to wire operator-escape-hatch importer overrides for address ${index}: ${safeErrorMessage(err)}`,
    );
  }

  // Issue #97 (steelman C1) — wire profile-resident outbox + SENT
  // ledger BEFORE payments.load() so the load-tail orphan sweeper
  // sees the writers. Mirrors the wiring in `initializeModules`
  // (primary address). Without this, multi-address wallets'
  // non-primary addresses silently fall back to the legacy KV
  // outbox — losing crash-safety guarantees.
  wireProfilePersistedSendStorageImpl(host, payments, identity);

  // payments.load() is critical — must succeed for wallet to be usable
  await payments.load();

  // Non-critical modules load in parallel — failures are non-fatal
  const results = await Promise.allSettled([
    communications.load(),
    groupChat?.load(),
    market?.load(),
    host._accounting?.load(),
    host._swap?.load(),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') {
      logger.warn('Sphere', 'Module load failed:', r.reason);
    }
  }

  // Issue #442 — arm the mux now that the new address's modules have
  // registered their handlers. Rebuilds the relay filter to include the
  // new pubkey alongside any previously-tracked addresses. See the
  // matching suppress call earlier in this method.
  if (host._transportMux) {
    try {
      await host._transportMux.armSubscriptions();
    } catch (err) {
      logger.warn(
        'Sphere',
        `[#442] mux armSubscriptions failed in initializeAddressModules (continuing — address ${index} will receive no events until reconnect): ${safeErrorMessage(err)}`,
      );
    }
  }

  const moduleSet: AddressModuleSet = {
    index,
    identity,
    payments,
    communications,
    groupChat,
    market,
    transportAdapter: adapter,
    tokenStorageProviders: new Map(tokenStorageProviders),
    initialized: true,
  };

  host._addressModules.set(index, moduleSet);
  logger.debug('Sphere', `Initialized per-address modules for address ${index} (transport: ${adapter ? 'mux adapter' : 'primary'})`);

  // Background sync after initialization
  payments.sync().catch((err) => {
    logger.warn('Sphere', `Post-init sync failed for address ${index}:`, err);
  });

  return moduleSet;
}

// =============================================================================
// Primary-address module bootstrap
// =============================================================================

/**
 * Initialize modules for the primary (default) address. Runs once from
 * `Sphere.create()` / `Sphere.load()` / `Sphere.import()` after
 * providers + identity are wired. Threads the tokenEngine, per-wallet
 * CID-ref store, IPFS publisher, transport mux, and Profile-backed
 * durable writers into every enabled module, then loads them (payments
 * critical + serial, others parallel best-effort), constructs the
 * {@link ConnectivityManager}, and arms both the outer transport's and
 * (if present) the mux's subscription gates.
 */
export async function initializeModulesImpl(host: ModulesInitHost): Promise<void> {
  const emitEvent = host.emitEvent.bind(host);

  // Create transport mux for address 0 so all addresses use per-address routing
  // from the start. The original transport stays connected for resolve operations.
  const adapter = await ensureTransportMuxImpl(host, host._currentAddressIndex, host._identity!);
  const moduleTransport: TransportProvider = adapter ?? host._transport;

  // G3 + G7 — Wire Profile-backed persisted storage for the recipient
  // cross-restart safety net. Mirrors the wiring in
  // `initializeAddressModules`. Best-effort — when StorageProvider
  // does not expose the builders, the auto-installed worker falls
  // back to the legacy in-memory shims.
  try {
    const storageWithBuilders = host._storage as unknown as {
      buildFinalizationQueueStorageAdapter?: () =>
        | import('../extensions/uxf/profile/finalization-queue-storage-adapter').OrbitDbFinalizationQueueStorageAdapter
        | null;
      buildRecipientContextStorageAdapter?: () =>
        | import('../extensions/uxf/profile/finalization-queue-storage-adapter').OrbitDbRecipientContextStorageAdapter
        | null;
    };
    const queueAdapter =
      typeof storageWithBuilders.buildFinalizationQueueStorageAdapter === 'function'
        ? storageWithBuilders.buildFinalizationQueueStorageAdapter()
        : null;
    const ctxAdapter =
      typeof storageWithBuilders.buildRecipientContextStorageAdapter === 'function'
        ? storageWithBuilders.buildRecipientContextStorageAdapter()
        : null;
    if (queueAdapter !== null || ctxAdapter !== null) {
      host._payments.configureRecipientPersistedStorage({
        ...(queueAdapter !== null
          ? { finalizationQueueStorage: queueAdapter }
          : {}),
        ...(ctxAdapter !== null ? { recipientContextStorage: ctxAdapter } : {}),
      });
    }
  } catch (err) {
    logger.warn(
      'Sphere',
      `G3/G7: failed to wire Profile-backed recipient persisted storage (continuing with in-memory shims): ${safeErrorMessage(err)}`,
    );
  }

  // Issue #285 — build the per-wallet CidRefStore once (lazy: returns
  // null if the storage provider is not Profile, encryption is off,
  // identity is not set yet, or IPFS gateways are not configured).
  // Pass it into every module that has a fat-data OpLog write site.
  const cidRefStore = buildCidRefStoreOrNullImpl(host);

  // Phase 6 — ensure v2 token engine before wiring into deps.
  await host.ensureTokenEngine();

  host._payments.initialize({
    identity: host._identity!,
    storage: host._storage,
    tokenStorageProviders: host._tokenStorageProviders,
    transport: moduleTransport,
    oracle: host._oracle,
    tokenEngine: host._tokenEngine ?? undefined,
    emitEvent,
price: host._priceProvider ?? undefined,
    disabledProviderIds: host._disabledProviders,
    // Issue #200 Phase 1 wiring — forward the canonical UXF CAR
    // publisher (built by the providers factory from the wallet's
    // IPFS gateway list). Absent → CID delivery falls back to inline
    // (under cap) or rejects (over cap / force-cid).
    publishToIpfs: host._publishToIpfs ?? undefined,
    cidFetchGateways: host._cidFetchGateways ?? undefined,
    // Issue #285 — CID-ref store for pending V5 token storage (fat-data).
    cidRefStore: cidRefStore ?? undefined,
    // Issue #255 Problem A — HD-index recovery hooks for
    // finalizeTransferToken. Only wired when a master key is
    // available (HD derivation requires it); without it,
    // finalize keeps single-identity behavior.
    ...(host._masterKey
      ? {
          deriveAddressInfo: (idx: number) =>
            host._deriveAddressInternal(idx, false),
          getActiveAddresses: () => host._getActiveAddressesInternal(),
        }
      : {}),
  });

  host._communications.initialize({
    identity: host._identity!,
    storage: host._storage,
    transport: moduleTransport,
    emitEvent,
    // Issue #285 — CID-ref store for the per-address DM cache.
    cidRefStore: cidRefStore ?? undefined,
  });

  host._groupChat?.initialize({
    identity: host._identity!,
    storage: host._storage,
    emitEvent,
    // Issue #285 — CID-ref store for group/member/messages/processedEvents
    // (the four GroupChat fat-data write sites flagged in #285).
    cidRefStore: cidRefStore ?? undefined,
  });

  host._market?.initialize({
    identity: host._identity!,
    emitEvent,
  });

  if (host._accounting) {
    const accountingTokenStorage = host._tokenStorageProviders.values().next().value;
    if (accountingTokenStorage) {
      // Resolve trustBase from oracle for invoice proof verification
      let trustBase: unknown = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        trustBase = (host._oracle as any).getTrustBase?.() ?? null;
      } catch {
        logger.warn('Sphere', 'Oracle does not support getTrustBase — invoice proof verification will be unavailable');
      }

      host._accounting.initialize({
        payments: host._payments,
        tokenStorage: accountingTokenStorage,
        oracle: host._oracle,
        tokenEngine: host._tokenEngine ?? undefined,
        trustBase,
        identity: host._identity!,
        getActiveAddresses: () => host._getActiveAddressesInternal(),
        emitEvent,
        on: host.on.bind(host),
        storage: host._storage,
        communications: host._communications,
        // Issue #285 — CID-ref store for invoice ledger (per-invoice
        // Pattern A pin via §8.3).
        cidRefStore: cidRefStore ?? undefined,
      });
    } else {
      logger.warn('Sphere', 'Accounting module enabled but no token storage available — disabling');
      host._accounting = null;
    }
  }

  if (host._swap) {
    if (host._accounting) {
      const acctForSwap = host._accounting;
      const onForSwap = host.on.bind(host);
      const paymentsForSwap = host._payments;
      const commsForSwap = host._communications;
      host._swap.initialize({
        accounting: {
          importInvoice: (token: unknown) => acctForSwap.importInvoice(token as Parameters<typeof acctForSwap.importInvoice>[0]),
          getInvoice: (id: string) => acctForSwap.getInvoice(id),
          getInvoiceStatus: (id: string) => acctForSwap.getInvoiceStatus(id),
          payInvoice: (id: string, params: unknown) => acctForSwap.payInvoice(id, params as Parameters<typeof acctForSwap.payInvoice>[1]),
          getTokenIdsForInvoice: (id: string) => acctForSwap.getTokenIdsForInvoice(id),
          on: onForSwap,
        },
        payments: { getToken: (id: string) => paymentsForSwap.getToken(id) },
        oracle: {
          isSpent: (pk: string, sh: string) => host._oracle.isSpent(pk, sh),
          getRootTrustBase: () =>
            (host._oracle as { getRootTrustBase?: () => unknown | null }).getRootTrustBase?.() ?? null,
        },
        communications: {
          sendDM: async (recipientPubkey: string, content: string) => {
            const msg = await commsForSwap.sendDM(recipientPubkey, content);
            return { eventId: msg.id };
          },
          onDirectMessage: (handler) => commsForSwap.onDirectMessage(handler),
        },
        storage: host._storage,
        identity: host._identity!,
        emitEvent,
        resolve: (id) => host._transport.resolve?.(id) ?? Promise.resolve(null),
        getActiveAddresses: () => host._getActiveAddressesInternal(),
      });
    } else {
      logger.warn('Sphere', 'Swap module enabled but accounting module not available — disabling');
      host._swap = null;
    }
  }

  // Round 7 (FIX 1) / Round 8 (FIX 1) — Wire production OrbitDb-backed
  // disposition storage AND the trust-base-aware proof verifier into
  // the operator escape-hatch InclusionProofImporter.
  //
  // Round 5 auto-installed an in-memory default that failed closed on
  // every operator-supplied proof; Round 7 swapped the disposition
  // storage for an OrbitDb-backed adapter so `_invalid` / `_audit`
  // records persist across restarts. Round 8 closes the remaining
  // verification gap: the importer's case 8 / 9 short-circuits now
  // run through `oracle.verifyInclusionProof()` (the same trust-base-
  // aware verifier the regular finalization workers use) instead of
  // the Round 7 fail-closed stub.
  //
  // The disposition-storage swap is best-effort: when the storage
  // provider is not a `ProfileStorageProvider` (e.g. legacy IndexedDB
  // / file storage), the auto-installed in-memory default stays in
  // place. The verifyProof wiring is ALWAYS attempted regardless of
  // storage provider — a real verifier on top of in-memory disposition
  // storage is still strictly better than the fail-closed stub
  // (operator probe calls return structured `proof-not-anchored` /
  // `proof-trustbase-failed` results instead of every proof being
  // dismissed as `NOT_AUTHENTICATED`).
  //
  // KNOWN LIMITATION: `graftCallback` / `overrideCallback` are NOT
  // wired here because the default builder's `queueScanner` returns
  // no entries — case 3 / 5 / 6 are unreachable in the auto-installed
  // harness. A follow-up wave will land a real `queueScanner` (the
  // FinalizationQueue-backed scanner) alongside production graft +
  // override callbacks; until then the no-op defaults are correct
  // (every reachable case routes through `verifyProof` first, and a
  // verified proof against an empty queue/manifest correctly resolves
  // to `'no-such-token'` or `'requestid-mismatch'`).
  try {
    // Duck-typed check: ProfileStorageProvider exposes
    // `buildDispositionStorageAdapter`. Other providers don't.
    const storageWithBuilder = host._storage as unknown as {
      buildDispositionStorageAdapter?: () =>
        | import('../extensions/uxf/profile/disposition-storage-adapters').OrbitDbDispositionStorageAdapter
        | null;
    };
    const builderAvailable =
      typeof storageWithBuilder.buildDispositionStorageAdapter === 'function';
    const adapter = builderAvailable
      ? storageWithBuilder.buildDispositionStorageAdapter!()
      : null;

    // Round 8 (FIX 1) — Build a verifyProof adapter that bridges the
    // {@link ImportableInclusionProof} shape used by the importer to
    // the oracle's `verifyInclusionProof` boolean API. The oracle
    // returns `true` only on `OK`; every other status (PATH_INVALID,
    // PATH_NOT_INCLUDED, NOT_AUTHENTICATED, THROWN) collapses to
    // `false`. We map `true → 'OK'` and `false → 'NOT_AUTHENTICATED'`
    // — losing the granular distinction between PATH_INVALID and
    // PATH_NOT_INCLUDED is acceptable because the importer's case 8
    // / 9 routing treats both as proof-trustbase-failed (only OK
    // proceeds to graft/override). A follow-up wave can plumb the
    // granular status if forensic distinction becomes load-bearing.
    //
    // The trustBase is loaded LAZILY: oracle.initialize() may run
    // after this hop (the oracle wires trustBase at first connect),
    // so the adapter resolves the trust-base on each call by calling
    // through `oracle.verifyInclusionProof()` which performs its own
    // null-check and throws `NOT_INITIALIZED` when trustBase is not
    // yet loaded. We catch and translate to `'NOT_AUTHENTICATED'` so
    // a probe call before oracle init does not crash bootstrap.
    const oracleForVerify = host._oracle as unknown as {
      verifyInclusionProof?: (input: {
        readonly proofJson: unknown;
        readonly transactionHash: string;
        readonly proofHash?: string;
      }) => Promise<boolean>;
    };
    const oracleHasVerify =
      typeof oracleForVerify.verifyInclusionProof === 'function';
    const verifyProofAdapter:
      | import('../extensions/uxf/pipeline/import-inclusion-proof').ProofVerifier
      | undefined = oracleHasVerify
      ? async (
          proof: import('../extensions/uxf/pipeline/import-inclusion-proof').ImportableInclusionProof,
        ): Promise<import('../extensions/uxf/pipeline/proof-verifier').ProofVerifyStatus> => {
          try {
            const ok = await oracleForVerify.verifyInclusionProof!({
              proofJson: proof.proof,
              transactionHash: proof.transactionHash,
            });
            return ok ? 'OK' : 'NOT_AUTHENTICATED';
          } catch {
            // Trust-base not loaded yet, network blip, malformed
            // input. Fail closed — the operator can retry once the
            // oracle finishes initialize(). Distinct from a
            // structurally-bad proof (which the oracle itself
            // returns false for); both collapse to the same case-9
            // routing here.
            return 'NOT_AUTHENTICATED';
          }
        }
      : undefined;

    if (adapter !== null && adapter !== undefined) {
      host._payments.configureOperatorEscapeHatchStorage(
        adapter,
        verifyProofAdapter !== undefined
          ? { verifyProof: verifyProofAdapter }
          : undefined,
      );
      // Issue #174 (DispositionWriter wiring) — primary-address
      // mirror of the multi-address wiring above. The OrbitDb
      // adapter backs BOTH the operator escape-hatch importer's
      // `_audit` writes and the spent-state-rescan worker's
      // off-record-spend AUDIT writes.
      try {
        const sphereEmit = host.emitEvent.bind(host);
        const auditWriter = await buildSpentStateAuditWriter(adapter, sphereEmit);
        host._payments.installSpentStateAuditWriter(auditWriter);
        logger.debug(
          'Sphere',
          'Wired spent-state-rescan AUDIT DispositionWriter (primary address)',
        );
      } catch (auditErr) {
        logger.warn(
          'Sphere',
          `Failed to wire spent-state-rescan AUDIT DispositionWriter (primary address): ${safeErrorMessage(auditErr)}`,
        );
      }
      logger.debug(
        'Sphere',
        'Wired OrbitDb-backed disposition storage + oracle.verifyInclusionProof into operator escape-hatch importer',
      );
    } else if (verifyProofAdapter !== undefined) {
      // No OrbitDb adapter, but we still have a real oracle —
      // upgrade just the verifier so the importer can validate
      // proofs even when running against in-memory disposition
      // storage. Use the public install* hook by rebuilding the
      // default importer with the verifier override.
      // Round 8 (FIX 1) — even without dispositionStorage upgrade,
      // verifyProof wiring is strictly better than the stub.
      const paymentsForVerify = host._payments as unknown as {
        configureOperatorEscapeHatchStorage?: (
          ds: import('../extensions/uxf/profile/disposition-writer').DispositionPerEntryStorage,
          options?: {
            readonly verifyProof?: import('../extensions/uxf/pipeline/import-inclusion-proof').ProofVerifier;
          },
        ) => void;
      };
      // Synthesize an in-memory dispositionStorage. We could reach
      // through to the auto-installed importer's existing
      // dispositionStorage instance, but rebuilding fresh keeps the
      // public surface narrow — the cost is one extra empty Map.
      const { InMemoryDispositionStorageAdapter } = await import(
        '../extensions/uxf/profile/disposition-storage-adapters'
      );
      if (typeof paymentsForVerify.configureOperatorEscapeHatchStorage === 'function') {
        paymentsForVerify.configureOperatorEscapeHatchStorage(
          new InMemoryDispositionStorageAdapter(),
          { verifyProof: verifyProofAdapter },
        );
        logger.debug(
          'Sphere',
          'Wired oracle.verifyInclusionProof into operator escape-hatch importer (in-memory disposition storage)',
        );
      }
    } else if (builderAvailable) {
      logger.debug(
        'Sphere',
        'ProfileStorageProvider returned null disposition adapter (encryption disabled or identity pending) — escape-hatch importer keeps in-memory default',
      );
    }
  } catch (err) {
    // Non-fatal: bootstrap continues with the auto-installed default.
    // The operator escape-hatch still works (just with the Round 7
    // fail-closed verifier stub). Round 8 (FIX 2) — use
    // `safeErrorMessage` so a hostile Proxy on `err` (throwing
    // getPrototypeOf / Symbol.hasInstance / .message getter) cannot
    // crash the bootstrap path. The previous pattern
    // (`err instanceof Error ? err.message : String(err)`) goes
    // through `instanceof` which calls Symbol.hasInstance — a
    // throwing trap escapes here.
    logger.warn(
      'Sphere',
      `Failed to wire operator-escape-hatch importer overrides — falling back to in-memory default: ${safeErrorMessage(err)}`,
    );
  }

  // Issue #97 — Build and install the profile-resident OutboxWriter
  // when the StorageProvider exposes `buildOutboxWriter`. The writer
  // persists per-entry-key UXF outbox entries under
  // `${addressId}.outbox.${id}` so they survive total local profile
  // loss (recovered on next sync via aggregator pointer / IPNS
  // snapshot). PaymentsModule's dispatcher hooks dual-write to this
  // writer plus the legacy KV chain; the SendingRecoveryWorker reads
  // from this writer on restart.
  //
  // Best-effort: when the storage provider is not a
  // `ProfileStorageProvider`, or encryption is disabled / key not yet
  // derived, the install is skipped and PaymentsModule falls back to
  // the legacy KV-only outbox path (pre-#97 behaviour).
  wireProfilePersistedSendStorageImpl(host, host._payments, host._identity);

  // PR #151 — payments.load() is critical and MUST complete BEFORE
  // accounting/swap load. `AccountingModule.load()` populates its
  // `invoiceTermsCache` by iterating `payments.getTokens()` (filter
  // by `tokenType === INVOICE_TOKEN_TYPE_HEX`); running it in parallel
  // with `payments.load()` reads from an empty `this.tokens` map and
  // leaves the cache empty until a later manual `accounting.load()`
  // — which the CLI never issues. Result: invoice-list / invoice-status
  // / invoice-pay all returned "not found" even though the invoice
  // token was persisted on disk. Mirrors the ordering in
  // `initializeAddressModules()` (line ~2566).
  await host._payments.load();

  // Non-critical modules load in parallel — failures are non-fatal
  const results = await Promise.allSettled([
    host._communications.load(),
    host._groupChat?.load(),
    host._market?.load(),
    host._accounting?.load(),
    host._swap?.load(),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') {
      logger.warn('Sphere', 'Module load failed:', r.reason);
    }
  }

  // Register in per-address module map
  host._addressModules.set(host._currentAddressIndex, {
    index: host._currentAddressIndex,
    identity: host._identity!,
    payments: host._payments,
    communications: host._communications,
    groupChat: host._groupChat,
    market: host._market,
    transportAdapter: adapter,
    tokenStorageProviders: new Map(host._tokenStorageProviders),
    initialized: true,
  });

  // Issue #312 — connectivity manager. Build AFTER providers are wired
  // (we read the transport's `isConnected()` and the oracle's
  // `getCurrentRound()`), but BEFORE returning so the public
  // `sphere.connectivity` accessor is live for any caller binding to
  // events immediately. `start()` returns sync; the first probe fires
  // on a microtask, so this does NOT block the init path.
  try {
    host._connectivity = host.buildConnectivityManager();
    host._connectivity.start();
  } catch (err) {
    // Non-fatal: a broken connectivity manager MUST NOT brick init().
    // The wallet remains fully functional; `sphere.connectivity` falls
    // through to the uninitialized stub (all-`'unknown'`).
    logger.warn(
      'Sphere',
      `Failed to build ConnectivityManager (sphere.connectivity will be inert): ${safeErrorMessage(err)}`,
    );
    host._connectivity = null;
  }

  // Wire the send-path gate. The PaymentsModule receives a snapshot
  // getter — it does NOT hold a reference to the manager, so a future
  // manager rebuild (post-address-switch) does not need to thread the
  // dependency back through.
  try {
    const paymentsForGate = host._payments as unknown as {
      configureConnectivityGate?: (
        fn: () => 'up' | 'down' | 'degraded' | 'unknown',
      ) => void;
    };
    if (typeof paymentsForGate.configureConnectivityGate === 'function') {
      paymentsForGate.configureConnectivityGate(() =>
        host._connectivity ? host._connectivity.status().aggregator : 'unknown',
      );
    }
  } catch (err) {
    logger.warn(
      'Sphere',
      `Failed to wire connectivity gate into PaymentsModule (sends will not gate on OFFLINE): ${safeErrorMessage(err)}`,
    );
  }

  // Issue #423 — arm the Nostr transport's subscription gate now that all
  // modules have registered their handlers (either directly on the outer
  // provider in the non-mux path, or on the MultiAddressTransportMux's
  // per-address adapter in the mux path).
  //
  // Pre-#423: `transport.connect()` opened the relay subscription inline,
  // BEFORE PaymentsModule / CommunicationsModule / AccountingModule /
  // SwapModule registered their `onTokenTransfer` / `onMessage` /
  // `onPaymentRequest` / `onPaymentRequestResponse` handlers. In the mux
  // path the outer provider never gets handlers at all (they live on the
  // mux adapter), so the outer subscription would route every TOKEN_TRANSFER
  // through the defensive `pendingTransfers` buffer and pin `lastEventTs`
  // — surfacing as the persistent `[AT-LEAST-ONCE] TOKEN_TRANSFER ... not
  // durable` warn storm in soak logs.
  //
  // For the mux path: `ensureTransportMux()` already called
  // `suppressSubscriptions()` on the outer provider, so the `armSubscriptions`
  // call below is a no-op (the gate short-circuits when suppressed). The
  // mux owns event routing and is independent.
  //
  // For the non-mux path: this is where the outer provider's subscription
  // actually opens. Idempotent — safe to re-call across `initializeModules`
  // re-runs (the gate is sticky).
  //
  // Duck-typed: legacy/test transports may not expose `armSubscriptions`.
  // No-op in that case — those transports never had the gated behavior.
  try {
    const transportWithArm = host._transport as unknown as {
      armSubscriptions?: () => Promise<void>;
    };
    if (typeof transportWithArm.armSubscriptions === 'function') {
      await transportWithArm.armSubscriptions();
    }
  } catch (err) {
    // Non-fatal — if arming throws (e.g., transient relay error during the
    // first subscribe), the auto-arm fallback inside the next `on*` handler
    // registration still covers us. Better to log and continue than to
    // brick init.
    logger.warn(
      'Sphere',
      `[#423] armSubscriptions failed (continuing — auto-arm fallback will retry): ${safeErrorMessage(err)}`,
    );
  }

  // Issue #442 — arm the MUX's relay subscription. Mirrors the #423 arm
  // above but for the mux path (which the #423 fix explicitly leaves as
  // a no-op — see the comment in the #423 block above for the
  // "suppressSubscriptions on the outer provider, mux owns event routing"
  // architecture). Without this, the mux's `updateSubscriptions()` never
  // runs after `ensureTransportMux()` suppressed it pre-connect, and the
  // wallet receives no DMs / token transfers / payment requests at all
  // (worse than the original bug — total event blackout instead of
  // late-handler drops). Always paired with the suppress call in
  // `ensureTransportMux`.
  if (host._transportMux) {
    try {
      await host._transportMux.armSubscriptions();
    } catch (err) {
      logger.warn(
        'Sphere',
        `[#442] mux armSubscriptions failed (continuing — wallet will receive no events until reconnect): ${safeErrorMessage(err)}`,
      );
    }
  }
}
