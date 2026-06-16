/**
 * Multi-Address Transport Multiplexer
 *
 * Wraps a single NostrTransportProvider to support multiple HD addresses
 * simultaneously. Each address gets a lightweight AddressTransportAdapter
 * that implements TransportProvider but shares the single WebSocket connection.
 *
 * Event routing:
 * - Wallet events (kind 4, 31113, 31115, 31116): routed by #p tag (recipient pubkey)
 * - Chat events (kind 1059 gift wrap): try decrypt with each address keyManager
 *
 * Sending: each adapter delegates to the inner transport with its own keyManager.
 */

import { Buffer } from 'buffer';
import {
  NostrKeyManager,
  NIP04,
  NIP17,
  Event as NostrEventClass,
  EventKinds,
  NostrClient,
  Filter,
  isChatMessage,
  isReadReceipt,
} from '@unicitylabs/nostr-js-sdk';
import type { ConnectionEventListener } from '@unicitylabs/nostr-js-sdk';
import { logger } from '../core/logger';
import { SphereError } from '../core/errors';
import { hexToBytes as strictHexToBytes } from '../core/hex';

import type { ProviderStatus, FullIdentity } from '../types';
import type {
  TransportProvider,
  MessageHandler,
  ComposingHandler,
  TokenTransferHandler,
  BroadcastHandler,
  PaymentRequestHandler,
  PaymentRequestResponseHandler,
  IncomingMessage,
  IncomingTokenTransfer,
  IncomingPaymentRequest,
  IncomingPaymentRequestResponse,
  TokenTransferPayload,
  PaymentRequestPayload,
  PaymentRequestResponsePayload,
  TransportEvent,
  TransportEventCallback,
  PeerInfo,
  ReadReceiptHandler,
  IncomingReadReceipt,
  TypingIndicatorHandler,
  IncomingTypingIndicator,
  InstantSplitBundlePayload,
  InstantSplitBundleHandler,
  IncomingInstantSplitBundle,
} from './transport-provider';
import type { WebSocketFactory, UUIDGenerator } from './websocket';
import { defaultUUIDGenerator } from './websocket';
import { NostrTransportProvider } from './NostrTransportProvider';
import type { TransportStorageAdapter, NostrTransportProviderConfig } from './NostrTransportProvider';
import {
  DEFAULT_NOSTR_RELAYS,
  LIMITS,
  NOSTR_EVENT_KINDS,
  STORAGE_KEYS_GLOBAL,
  TIMEOUTS,
} from '../constants';

// Alias for backward compatibility
const EVENT_KINDS = NOSTR_EVENT_KINDS;
const COMPOSING_INDICATOR_KIND = 25050;

// NIP-17 gift wraps randomize created_at by ±2 days for privacy.
// Subscriptions and one-shot queries must look further back by this window
// so the relay returns events whose actual send time is recent even if their
// created_at was shifted into the past.
const NIP17_TIMESTAMP_RANDOMIZATION = 2 * 24 * 60 * 60; // 172800 s

// =============================================================================
// Nostr Event type (local, matching NostrTransportProvider)
// =============================================================================

interface NostrEvent {
  id: string;
  kind: number;
  content: string;
  tags: string[][];
  pubkey: string;
  created_at: number;
  sig: string;
}

// =============================================================================
// Address Entry — per-address state managed by the mux
// =============================================================================

interface AddressEntry {
  index: number;
  identity: FullIdentity;
  keyManager: NostrKeyManager;
  nostrPubkey: string;
  adapter: AddressTransportAdapter;
  lastEventTs: number;
  lastDmEventTs: number;
  fallbackSince: number | null;
  fallbackDmSince: number | null;
}

// =============================================================================
// MultiAddressTransportMux
// =============================================================================

export interface MultiAddressTransportMuxConfig {
  relays?: string[];
  timeout?: number;
  autoReconnect?: boolean;
  reconnectDelay?: number;
  maxReconnectAttempts?: number;
  createWebSocket: WebSocketFactory;
  generateUUID?: UUIDGenerator;
  storage?: TransportStorageAdapter;
  /** Private key for the Mux's NostrClient identity. If provided, the Mux
   *  authenticates as this key — required for relays that filter gift-wrap
   *  event delivery to the recipient's subscription.
   *  Ignored when {@link sharedNostrClient} is set. */
  identityPrivateKey?: Uint8Array;
  /**
   * Optional pre-existing {@link NostrClient} to reuse instead of opening a
   * fresh WebSocket per relay (#123). When set, the Mux skips both the
   * {@code new NostrClient(...)} construction and {@code connect()} — it
   * only registers subscription/connection listeners on the shared
   * client. The Mux does NOT take ownership: its {@code disconnect()}
   * leaves the client connected, since the caller (e.g. the original
   * {@link NostrTransportProvider}) still uses it for resolve calls.
   *
   * Use a getter when the client may be created lazily (e.g. before the
   * provider has connected).
   */
  sharedNostrClient?: NostrClient | null | (() => NostrClient | null);
}

export class MultiAddressTransportMux {
  private config: Required<Omit<MultiAddressTransportMuxConfig, 'createWebSocket' | 'generateUUID' | 'storage' | 'identityPrivateKey' | 'sharedNostrClient'>> & {
    createWebSocket: WebSocketFactory;
    generateUUID: UUIDGenerator;
  };
  private storage: TransportStorageAdapter | null = null;

  // Single NostrClient — one WebSocket connection for all addresses
  private nostrClient: NostrClient | null = null;
  // KeyManager used for NostrClient creation (uses first address or temp key)
  private primaryKeyManager: NostrKeyManager | null = null;
  private status: ProviderStatus = 'disconnected';

  // Per-address entries
  private addresses = new Map<number, AddressEntry>();
  // pubkey → address index (for fast routing)
  private pubkeyToIndex = new Map<string, number>();

  // Subscription IDs
  private walletSubscriptionId: string | null = null;
  private chatSubscriptionId: string | null = null;
  private chatEoseFired = false;
  private resubscribeTimer: ReturnType<typeof setTimeout> | null = null;
  private chatEoseHandlers: Array<() => void> = [];

  // Dedup — bounded to prevent memory leak in long-running sessions.
  // Set preserves insertion order; evict oldest entries when cap is reached.
  //
  // Issue #275: This set is PERSISTED via `storage` so cross-process CLI
  // invocations don't re-walk the relay backlog through the Mux path.
  // Without persistence, every `sphere <cmd>` paid the legacy SDK-format
  // path's 4-8s per-event cost for events the prior process already
  // finalized. See `hydrateProcessedDedup` / `schedulePersistDedup` below.
  // FIFO eviction is at `LIMITS.PROCESSED_EVENT_IDS_CAP`.
  private processedEventIds = new Set<string>();
  private static readonly MAX_PROCESSED_IDS = LIMITS.PROCESSED_EVENT_IDS_CAP;
  /** Debounce timer for persisted dedup writes (#275). */
  private persistDedupTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serialize concurrent persistDedupNow calls (#275). */
  private persistDedupInFlight: Promise<void> | null = null;
  /** Gates re-hydration; true after the first successful load (#275). */
  private dedupHydrated = false;

  // Event callbacks (mux-level, forwarded to all adapters)
  private eventCallbacks: Set<TransportEventCallback> = new Set();

  // Identity key for the Mux's NostrClient — relays may filter gift-wrap
  // delivery to the recipient's subscription key.
  private readonly identityPrivateKey: Uint8Array | undefined;

  // Resolves the shared NostrClient at use-time (the source provider may
  // create its client lazily, after the Mux is constructed). null means
  // "no shared client; create our own."
  private readonly sharedNostrClientGetter: (() => NostrClient | null) | null;
  // True when this Mux is using a shared NostrClient and therefore must
  // not call connect()/disconnect() on it.
  private usingSharedClient = false;
  // Listener registered on the underlying NostrClient. Tracked so we can
  // remove it on disconnect / rebind — otherwise a long-lived shared
  // client accumulates listeners across address switches and (worse)
  // a "disconnected" Mux still sees onReconnected callbacks fire and
  // re-establish subscriptions it shouldn't have.
  private connectionListener: ConnectionEventListener | null = null;

  // Issue #442 — gate the relay subscription open until all module DM
  // handlers (CommunicationsModule + late-registering fan-out subscribers:
  // SwapModule, AccountingModule, GroupChatModule, MarketModule) have
  // attached. Default-armed for backward compat with consumers that build
  // a Mux directly without going through Sphere bootstrap; Sphere
  // explicitly calls {@link suppressSubscriptions} before
  // {@link connect} so the gate opens on the explicit
  // {@link armSubscriptions} call after every module's `load()` returns.
  //
  // When suppressed, {@link updateSubscriptions} short-circuits before
  // touching the relay (no unsubscribe of stale IDs, no resubscribe). The
  // mux still tracks addresses, but the relay sub stays in its previous
  // state — closed for a freshly-connected Mux, or the prior address
  // filter for the multi-address-switch path (primary keeps receiving
  // events through the existing sub during the gate window).
  private subscriptionsArmed = true;

  constructor(config: MultiAddressTransportMuxConfig) {
    this.identityPrivateKey = config.identityPrivateKey;
    this.config = {
      relays: config.relays ?? [...DEFAULT_NOSTR_RELAYS],
      timeout: config.timeout ?? TIMEOUTS.WEBSOCKET_CONNECT,
      autoReconnect: config.autoReconnect ?? true,
      reconnectDelay: config.reconnectDelay ?? TIMEOUTS.NOSTR_RECONNECT_DELAY,
      maxReconnectAttempts: config.maxReconnectAttempts ?? TIMEOUTS.MAX_RECONNECT_ATTEMPTS,
      createWebSocket: config.createWebSocket,
      generateUUID: config.generateUUID ?? defaultUUIDGenerator,
    };
    this.storage = config.storage ?? null;

    if (typeof config.sharedNostrClient === 'function') {
      this.sharedNostrClientGetter = config.sharedNostrClient;
    } else if (config.sharedNostrClient) {
      const c = config.sharedNostrClient;
      this.sharedNostrClientGetter = () => c;
    } else {
      this.sharedNostrClientGetter = null;
    }
  }

  // ===========================================================================
  // Address Management
  // ===========================================================================

  /**
   * Add an address to the multiplexer.
   * Creates an AddressTransportAdapter for this address.
   * If already connected, updates subscriptions to include the new pubkey.
   */
  async addAddress(index: number, identity: FullIdentity, resolveDelegate?: TransportProvider | null): Promise<AddressTransportAdapter> {
    // If already registered, update identity and return existing adapter
    const existing = this.addresses.get(index);
    if (existing) {
      existing.identity = identity;
      existing.keyManager = NostrKeyManager.fromPrivateKey(strictHexToBytes(identity.privateKey));
      existing.nostrPubkey = existing.keyManager.getPublicKeyHex();
      // Update pubkey mapping
      for (const [pk, idx] of this.pubkeyToIndex) {
        if (idx === index) this.pubkeyToIndex.delete(pk);
      }
      this.pubkeyToIndex.set(existing.nostrPubkey, index);
      logger.debug('Mux', `Updated address ${index}, pubkey: ${existing.nostrPubkey.slice(0, 16)}...`);
      await this.updateSubscriptions();
      return existing.adapter;
    }

    const keyManager = NostrKeyManager.fromPrivateKey(strictHexToBytes(identity.privateKey));
    const nostrPubkey = keyManager.getPublicKeyHex();

    const adapter = new AddressTransportAdapter(this, index, identity, resolveDelegate);

    const entry: AddressEntry = {
      index,
      identity,
      keyManager,
      nostrPubkey,
      adapter,
      lastEventTs: 0,
      lastDmEventTs: 0,
      fallbackSince: null,
      fallbackDmSince: null,
    };

    this.addresses.set(index, entry);
    this.pubkeyToIndex.set(nostrPubkey, index);

    logger.debug('Mux', `Added address ${index}, pubkey: ${nostrPubkey.slice(0, 16)}..., total: ${this.addresses.size}`);

    // Update primary key manager if this is the first address
    if (this.addresses.size === 1) {
      this.primaryKeyManager = keyManager;
    }

    // If already connected, update subscriptions
    if (this.isConnected()) {
      await this.updateSubscriptions();
    }

    return adapter;
  }

  /**
   * Remove an address from the multiplexer.
   * Stops routing events to this address.
   */
  async removeAddress(index: number): Promise<void> {
    const entry = this.addresses.get(index);
    if (!entry) return;

    this.pubkeyToIndex.delete(entry.nostrPubkey);
    this.addresses.delete(index);

    logger.debug('Mux', `Removed address ${index}, remaining: ${this.addresses.size}`);

    // Update subscriptions if connected
    if (this.isConnected() && this.addresses.size > 0) {
      await this.updateSubscriptions();
    }
  }

  /**
   * Get adapter for a specific address index.
   */
  getAdapter(index: number): AddressTransportAdapter | undefined {
    return this.addresses.get(index)?.adapter;
  }

  /**
   * Set fallback 'since' for an address (consumed once on next subscription setup).
   */
  setFallbackSince(index: number, sinceSeconds: number): void {
    const entry = this.addresses.get(index);
    if (entry) {
      entry.fallbackSince = sinceSeconds;
    }
  }

  setFallbackDmSince(index: number, sinceSeconds: number): void {
    const entry = this.addresses.get(index);
    if (entry) {
      entry.fallbackDmSince = sinceSeconds;
    }
  }

  // ===========================================================================
  // Connection Management (delegated from adapters)
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.status === 'connected') return;
    this.status = 'connecting';

    try {
      // Prefer a shared NostrClient when the host (e.g. NostrTransportProvider)
      // already has one open against the same relay set (#123). Sharing means
      // a single WebSocket per relay instead of two.
      const shared = this.sharedNostrClientGetter ? this.sharedNostrClientGetter() : null;
      if (shared) {
        if (!shared.isConnected()) {
          throw new SphereError(
            'sharedNostrClient is not connected; the Mux cannot share a closed socket',
            'TRANSPORT_ERROR',
          );
        }
        this.nostrClient = shared;
        this.usingSharedClient = true;
      } else {
        // Use the identity key if provided (avoids relay filtering issues where
        // gift-wrap events are only pushed to subscriptions from the recipient's key).
        // Falls back to random key.
        if (!this.primaryKeyManager) {
          if (this.identityPrivateKey) {
            this.primaryKeyManager = NostrKeyManager.fromPrivateKey(
              Buffer.from(this.identityPrivateKey),
            );
          } else {
            const tempKey = Buffer.alloc(32);
            crypto.getRandomValues(tempKey);
            this.primaryKeyManager = NostrKeyManager.fromPrivateKey(tempKey);
          }
        }

        this.nostrClient = new NostrClient(this.primaryKeyManager, {
          autoReconnect: this.config.autoReconnect,
          reconnectIntervalMs: this.config.reconnectDelay,
          maxReconnectIntervalMs: this.config.reconnectDelay * 16,
          // pingIntervalMs intentionally raised. The 15 s interval combined with
          // the SDK's no-filter `['REQ','ping',{limit:1}]` keepalive trick has
          // been observed to false-positive on real testnet under uneven relay
          // response timing — the relay floods events to a no-filter sub but
          // occasional 30+ s gaps in that flood (rate-limit / backend hiccup)
          // race the 30 s stale threshold. The Mux already runs its own
          // application-layer chat-event health check (see
          // `[Mux] No chat events for X — re-subscribing` in this file), so
          // we don't rely on NostrClient's stale-detect for liveness — we
          // raise the interval to push the false-positive past any realistic
          // run, while keeping the timer in place as a defense-in-depth signal.
          pingIntervalMs: 60000,
        });
      }

      this.connectionListener = this.buildConnectionListener();
      this.nostrClient.addConnectionListener(this.connectionListener);

      if (!this.usingSharedClient) {
        await Promise.race([
          this.nostrClient.connect(...this.config.relays),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(
              `Transport connection timed out after ${this.config.timeout}ms`
            )), this.config.timeout)
          ),
        ]);

        if (!this.nostrClient.isConnected()) {
          throw new SphereError('Failed to connect to any relay', 'TRANSPORT_ERROR');
        }
      }

      this.status = 'connected';
      this.emitEvent({ type: 'transport:connected', timestamp: Date.now() });

      // Set up subscriptions for all registered addresses
      if (this.addresses.size > 0) {
        await this.updateSubscriptions();
      }
    } catch (error) {
      this.status = 'error';
      // Clean up any partial state so a subsequent connect() doesn't
      // pile a second listener (and a second NostrClient) onto the
      // first attempt's orphan. Without this, the connect-timeout +
      // retry path leaks a listener and a half-initialised client per
      // failed attempt.
      if (this.connectionListener && this.nostrClient) {
        try { this.nostrClient.removeConnectionListener(this.connectionListener); } catch { /* ignore */ }
      }
      this.connectionListener = null;
      if (this.nostrClient && !this.usingSharedClient) {
        try { this.nostrClient.disconnect(); } catch { /* ignore */ }
      }
      this.nostrClient = null;
      this.usingSharedClient = false;
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // Issue #275 — flush any pending dedup write BEFORE tearing down
    // the connection. A process exit that catches the tail of a
    // 200ms debounce window would otherwise lose the latest adds
    // and force the next process to re-walk the same relay backlog.
    if (this.persistDedupTimer) {
      clearTimeout(this.persistDedupTimer);
      this.persistDedupTimer = null;
    }
    if (this.storage) {
      try {
        await this.persistDedupNow();
      } catch (err) {
        logger.debug('Mux', '[#275] disconnect: flush of persisted dedup failed:', err);
      }
    }

    if (this.resubscribeTimer) {
      clearTimeout(this.resubscribeTimer);
      this.resubscribeTimer = null;
    }
    if (this.nostrClient) {
      // When the client is shared with another component (e.g. the
      // outer NostrTransportProvider), that component owns the
      // socket lifecycle. Tearing it down here would kill resolve
      // calls and break #123's whole point — drop just our
      // subscriptions and our reference.
      if (this.walletSubscriptionId) {
        try { this.nostrClient.unsubscribe(this.walletSubscriptionId); } catch { /* ignore */ }
      }
      if (this.chatSubscriptionId) {
        try { this.nostrClient.unsubscribe(this.chatSubscriptionId); } catch { /* ignore */ }
      }
      // Detach our connection listener BEFORE dropping the reference.
      // For a shared client this is critical — without it the listener
      // continues firing on every reconnect and would re-establish
      // subscriptions on a "disconnected" Mux. For an owned client it's
      // about to be disposed, but removing is cheap and tidy.
      if (this.connectionListener) {
        try { this.nostrClient.removeConnectionListener(this.connectionListener); } catch { /* ignore */ }
      }
      if (!this.usingSharedClient) {
        this.nostrClient.disconnect();
      }
      this.nostrClient = null;
    }
    this.connectionListener = null;
    this.usingSharedClient = false;
    this.walletSubscriptionId = null;
    this.chatSubscriptionId = null;
    this.chatEoseFired = false;
    this.status = 'disconnected';
    this.emitEvent({ type: 'transport:disconnected', timestamp: Date.now() });
  }

  isConnected(): boolean {
    return this.status === 'connected' && this.nostrClient?.isConnected() === true;
  }

  // ===========================================================================
  // Issue #442 — Subscription gate (mirror of NostrTransportProvider's #423
  // gate, but for the mux path which #423 left uncovered).
  //
  // Pre-#442: `ensureTransportMux()` opened the WebSocket and immediately
  // called `updateSubscriptions()` (via `connect()` / `addAddress()`), so
  // the relay started replaying events BEFORE Sphere's module loads
  // registered their handlers. Events that arrived before
  // `SwapModule.load()` ran its `communications.onDirectMessage(...)` were
  // routed through `CommunicationsModule.handleIncomingMessage` (which
  // persisted to inbox) but missed the late-registering fan-out
  // subscribers entirely — so a `swap_proposal:` DM landed in `sphere dm
  // history` but `sphere swap list` returned "No swaps found".
  //
  // The gate decouples WebSocket open from relay-subscription open. Sphere
  // bootstrap suppresses BEFORE `connect()`, runs all module loads, then
  // arms — guaranteeing every onDirectMessage subscriber is wired before
  // the relay starts streaming.
  // ===========================================================================

  /**
   * Suppress the relay subscription so {@link updateSubscriptions} becomes a
   * no-op. The WebSocket stays open (so resolve / sendDM still work), but no
   * new wallet / chat filter is registered with the relay. Active filters
   * registered before suppression are NOT torn down — they continue
   * delivering events for the still-tracked pubkeys.
   *
   * Idempotent. Sticky until {@link armSubscriptions} is called.
   *
   * Used by:
   *   - `Sphere.ensureTransportMux` BEFORE `connect()` on first
   *     creation, so the initial address's `addAddress(...)` auto-update
   *     no-ops until module handlers register.
   *   - `Sphere.initializeAddressModules` BEFORE adding a non-primary
   *     address, so the relay filter is not rebuilt with the new pubkey
   *     until the new address's modules finish loading. (The primary
   *     address's active filter keeps delivering events through the
   *     suppression window — we explicitly do NOT unsubscribe here.)
   */
  suppressSubscriptions(): void {
    if (!this.subscriptionsArmed) return;
    this.subscriptionsArmed = false;
    logger.debug('Mux', '[#442] Subscriptions suppressed — updateSubscriptions deferred until armSubscriptions()');
  }

  /**
   * Arm the relay subscription. Sets armed=true and (when connected with
   * at least one tracked address) rebuilds the wallet / chat filters via
   * {@link updateSubscriptions}. Always rebuilds so multi-address switch
   * paths can use this as the "open relay sub for the newly-added pubkey
   * now that its modules have loaded" trigger — `armSubscriptions()` after
   * a previous `armSubscriptions()` is NOT a no-op when new addresses have
   * been registered in between.
   *
   * Safe to call before {@link connect}; the gate stays open, and connect
   * will subscribe inline when it reaches its tail (existing behaviour).
   *
   * Returns once `updateSubscriptions` resolves so callers can await an
   * established subscription before proceeding.
   */
  async armSubscriptions(): Promise<void> {
    this.subscriptionsArmed = true;
    if (this.isConnected() && this.addresses.size > 0) {
      await this.updateSubscriptions();
    }
    logger.debug('Mux', '[#442] Subscriptions armed');
  }

  /** For tests and operator inspection. */
  isSubscriptionsArmed(): boolean {
    return this.subscriptionsArmed;
  }

  /**
   * Build the connection listener used by both {@link connect} and
   * {@link rebindToSharedClient}.
   *
   * Behavioral notes:
   * - When the Mux is sharing a {@link NostrClient} with the host
   *   transport (#123), we deliberately do NOT emit
   *   {@code transport:connected} / {@code transport:reconnecting} here
   *   — the host transport's own listener already emits those for the
   *   same socket event. Re-subscribing after a reconnect IS still our
   *   responsibility, since the host has
   *   {@code suppressSubscriptions()}'d its own filters.
   * - {@code onConnect} does not emit {@code transport:connected}.
   *   The SDK only fires {@code onConnect} on the initial socket
   *   connection (subsequent reconnects use {@code onReconnected}),
   *   and {@link connect()}'s bottom already emits
   *   {@code transport:connected} once that returns. Emitting here too
   *   would double-fire on every initial connect.
   * - Each callback bails out early when the Mux is not in an active
   *   state ({@code disconnected} / {@code error}). Listeners are
   *   removed on {@code disconnect()} before the callback can fire,
   *   so this guard is mainly defense-in-depth against any in-flight
   *   callback that lands during teardown — but having it at the top
   *   means we never emit a misleading {@code transport:connected}
   *   from a Mux that has already torn down.
   */
  private buildConnectionListener(): ConnectionEventListener {
    const isInactive = (): boolean =>
      this.status === 'disconnected' || this.status === 'error';

    return {
      onConnect: (url) => {
        if (isInactive()) return;
        logger.debug('Mux', 'Connected to relay:', url);
        // Intentionally no emit here — see method-level comment.
      },
      onDisconnect: (url, reason) => {
        // No early-return: a disconnect callback during teardown is
        // expected and benign; we just log it.
        logger.debug('Mux', 'Disconnected from relay:', url, 'reason:', reason);
      },
      onReconnecting: (url, attempt) => {
        if (isInactive()) return;
        logger.debug('Mux', 'Reconnecting to relay:', url, 'attempt:', attempt);
        if (!this.usingSharedClient) {
          this.emitEvent({ type: 'transport:reconnecting', timestamp: Date.now() });
        }
      },
      onReconnected: (url) => {
        if (isInactive()) return;
        logger.debug('Mux', 'Reconnected to relay:', url);
        if (!this.usingSharedClient) {
          this.emitEvent({ type: 'transport:connected', timestamp: Date.now() });
        }
        // Re-establish subscriptions — the relay drops them on disconnect.
        //
        // Issue #442 caveat: if reconnect lands inside the bootstrap
        // suppression window (between `ensureTransportMux` and the
        // trailing `armSubscriptions` in `initializeModules`), this
        // call short-circuits at the gate inside `updateSubscriptions`
        // and no rebuild fires here. That's intentional — `arm`
        // itself calls `updateSubscriptions` unconditionally, so the
        // explicit arm masks rebuilds dropped during the suppress
        // window. Outside the bootstrap window the gate is open and
        // this path behaves as before.
        this.updateSubscriptions().catch((err) => {
          logger.error('Mux', 'Failed to re-subscribe after reconnect:', err);
        });
      },
    };
  }

  /**
   * Re-attach to a freshly-created shared NostrClient.
   *
   * Call this after the host (e.g. {@link NostrTransportProvider}) has
   * recreated its NostrClient — typically because the wallet's active
   * identity changed and the SDK's NostrClient does not support
   * changing identity at runtime. The previous client has already
   * been disconnected by the host, so its server-side subscriptions
   * are gone — we just adopt the new client and re-issue our own.
   *
   * The caller is responsible for ordering: by the time rebind runs,
   * the host transport's new NostrClient must already be created and
   * connected. In Sphere this is guaranteed because we await
   * {@code transport.setIdentity()} before calling rebind.
   *
   * Returns silently in two cases that are not caller errors:
   *   - the Mux owns its own client (not sharing) — nothing to rebind
   *   - the shared client reference hasn't changed (rebind is a no-op)
   *
   * Throws otherwise (rather than silently no-op'ing) so a wiring
   * mistake — for instance, calling rebind before the host's new
   * client is ready — surfaces immediately instead of leaving the
   * Mux pinned to a stale client.
   */
  async rebindToSharedClient(): Promise<void> {
    if (!this.usingSharedClient) return;
    if (!this.sharedNostrClientGetter) return;

    const newClient = this.sharedNostrClientGetter();
    if (!newClient) {
      throw new SphereError(
        'rebindToSharedClient: shared client getter returned null. ' +
        'The host transport must finish (re)creating its NostrClient before rebind is called.',
        'TRANSPORT_ERROR',
      );
    }
    if (this.nostrClient === newClient) return;
    if (!newClient.isConnected()) {
      throw new SphereError(
        'rebindToSharedClient: new shared client is not connected. ' +
        'Await transport.setIdentity() / transport.connect() before rebinding.',
        'TRANSPORT_ERROR',
      );
    }

    // Detach our listener from the old client. It's already been
    // disconnected by the host so it won't fire callbacks anyway, but
    // removing keeps the SDK's listener list tidy and avoids any
    // implementation detail where listeners might survive a disconnect.
    if (this.nostrClient && this.connectionListener && this.nostrClient !== newClient) {
      try { this.nostrClient.removeConnectionListener(this.connectionListener); } catch { /* ignore */ }
    }

    // Drop stale state. The relay dropped wallet/chat subs when the
    // previous client disconnected, so the IDs are dead — don't try
    // to unsubscribe through the now-disposed client.
    this.nostrClient = newClient;
    this.walletSubscriptionId = null;
    this.chatSubscriptionId = null;
    this.chatEoseFired = false;

    this.connectionListener = this.buildConnectionListener();
    this.nostrClient.addConnectionListener(this.connectionListener);

    if (this.addresses.size > 0) {
      await this.updateSubscriptions();
    }
  }

  /**
   * One-shot fetch of pending events from the relay.
   * Creates a temporary subscription, waits for EOSE (or timeout),
   * then processes all collected events through the mux dispatch chain.
   * This ensures DMs (swap proposals, invoice receipts, etc.) are processed
   * before the CLI reads in-memory state.
   */
  async fetchPendingEvents(): Promise<void> {
    // Capture client reference to avoid race with concurrent disconnect() call
    const client = this.nostrClient;
    if (!client?.isConnected() || this.addresses.size === 0) return;

    const allPubkeys: string[] = [];
    for (const entry of this.addresses.values()) {
      allPubkeys.push(entry.nostrPubkey);
    }

    // Fetch gift-wrapped DMs (NIP-17, kind 1059) — these carry swap proposals,
    // invoice receipts, escrow messages, etc.
    const filter = new Filter();
    filter.kinds = [
      EVENT_KINDS.DIRECT_MESSAGE,
      EVENT_KINDS.TOKEN_TRANSFER,
      EVENT_KINDS.PAYMENT_REQUEST,
      EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
      EventKinds.GIFT_WRAP,
    ];
    filter['#p'] = allPubkeys;
    // Look back 24h for wallet events, plus the NIP-17 ±2-day randomization
    // window for gift wraps. Without this, gift wraps whose created_at was
    // shifted more than 24h into the past would be invisible to the relay filter.
    filter.since = Math.floor(Date.now() / 1000) - 86400 - NIP17_TIMESTAMP_RANDOMIZATION;

    const events: NostrEvent[] = [];
    // Declared outside the Promise so it's available for cleanup after resolve.
    let subId: string | undefined;

    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      // settle() only resolves the Promise — unsubscribe happens AFTER the Promise
      // resolves (below), where subId is guaranteed to be the real subscription ID.
      // This fixes a synchronous-EOSE race: if EOSE fires inside subscribe() before
      // the call returns, settle() is called with subId still undefined, so we must
      // not unsubscribe here.
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };

      try {
        subId = client.subscribe(filter, {
          onEvent: (event) => {
            events.push({
              id: event.id,
              kind: event.kind,
              content: event.content,
              tags: event.tags,
              pubkey: event.pubkey,
              created_at: event.created_at,
              sig: event.sig,
            });
          },
          onEndOfStoredEvents: () => settle(),
        });
      } catch (err) {
        reject(err);
        return;
      }

      if (!settled) {
        timeout = setTimeout(() => settle(), 5000);
      }
    });

    // Unsubscribe AFTER the Promise resolves — subId is now the real subscription ID.
    // This also ensures onEvent cannot fire while we iterate events below.
    if (subId) { try { client.unsubscribe(subId); } catch { /* disconnected */ } }

    // Process through mux dispatch chain (dedup handles already-seen events)
    for (const event of events) {
      await this.handleEvent(event);
    }

    // Issue #464 — flush any drain promises tracked by adapters during this
    // call. `dispatch*` already awaits handler completion for events
    // delivered through `handleEvent`, but if a late handler registration
    // occurred concurrently (its drain runs as a tracked async IIFE),
    // we must also wait for that drain to settle before returning so
    // the caller's next `load()` / state read sees a consistent view.
    for (const entry of this.addresses.values()) {
      try { await entry.adapter.flushPendingDrains(); }
      catch (e) { logger.debug('Mux', 'flushPendingDrains error:', e); }
    }

    logger.debug('Mux', `fetchPendingEvents: processed ${events.length} events`);
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  // ===========================================================================
  // Relay Management
  // ===========================================================================

  getRelays(): string[] {
    return [...this.config.relays];
  }

  getConnectedRelays(): string[] {
    if (!this.nostrClient) return [];
    return Array.from(this.nostrClient.getConnectedRelays());
  }

  async addRelay(relayUrl: string): Promise<boolean> {
    if (this.config.relays.includes(relayUrl)) return false;
    this.config.relays.push(relayUrl);

    if (this.status === 'connected' && this.nostrClient) {
      try {
        await this.nostrClient.connect(relayUrl);
        this.emitEvent({ type: 'transport:relay_added', timestamp: Date.now(), data: { relay: relayUrl, connected: true } });
        return true;
      } catch (error) {
        this.emitEvent({ type: 'transport:relay_added', timestamp: Date.now(), data: { relay: relayUrl, connected: false, error: String(error) } });
        return false;
      }
    }
    return true;
  }

  async removeRelay(relayUrl: string): Promise<boolean> {
    const idx = this.config.relays.indexOf(relayUrl);
    if (idx === -1) return false;
    this.config.relays.splice(idx, 1);
    this.emitEvent({ type: 'transport:relay_removed', timestamp: Date.now(), data: { relay: relayUrl } });
    return true;
  }

  hasRelay(relayUrl: string): boolean {
    return this.config.relays.includes(relayUrl);
  }

  isRelayConnected(relayUrl: string): boolean {
    if (!this.nostrClient) return false;
    return this.nostrClient.getConnectedRelays().has(relayUrl);
  }

  // ===========================================================================
  // Subscription Management
  // ===========================================================================

  /**
   * Update Nostr subscriptions to listen for events on ALL registered address pubkeys.
   * Called whenever addresses are added/removed.
   */
  private async updateSubscriptions(): Promise<void> {
    if (!this.nostrClient) return;

    // Issue #442 — Subscription gate. When suppressed (Sphere bootstrap
    // before module loads complete, or the multi-address switch window)
    // skip the relay update entirely. Critically, this MUST short-circuit
    // BEFORE the stale-ID unsubscribe below — otherwise a suppress that
    // lands between two updateSubscriptions calls would tear down the
    // active sub without rebuilding it, dropping incoming events for the
    // already-tracked addresses.
    if (!this.subscriptionsArmed) {
      logger.debug('Mux', '[#442] updateSubscriptions deferred — subscriptions not armed');
      return;
    }

    // Issue #275 — hydrate persistent dedup BEFORE EOSE replay arrives.
    // The first CLI command of a new process otherwise re-walks the
    // entire backlog through the Mux's `handleEvent`, paying the legacy
    // SDK-format path's 4-8s addToken probe per event.
    await this.hydrateProcessedDedup();

    // Always unsubscribe stale IDs first — the relay drops server-side
    // subscriptions on disconnect, so these IDs are dead after reconnect.
    if (this.walletSubscriptionId) {
      this.nostrClient.unsubscribe(this.walletSubscriptionId);
      this.walletSubscriptionId = null;
    }
    if (this.chatSubscriptionId) {
      this.nostrClient.unsubscribe(this.chatSubscriptionId);
      this.chatSubscriptionId = null;
    }

    // Nothing to subscribe to if no addresses registered
    if (this.addresses.size === 0) return;

    // Collect all pubkeys
    const allPubkeys: string[] = [];
    for (const entry of this.addresses.values()) {
      allPubkeys.push(entry.nostrPubkey);
    }

    logger.debug('Mux', `Subscribing for ${allPubkeys.length} address(es):`, allPubkeys.map(p => p.slice(0, 12)).join(', '));

    // Determine global 'since' for wallet and DM subscriptions in one pass.
    // Each address has independent stored timestamps; we take the minimum.
    let globalSince = Math.floor(Date.now() / 1000);
    let globalDmSince = Math.floor(Date.now() / 1000);
    const entries = [...this.addresses.values()];
    const sinceResults = await Promise.all(
      entries.map(async (entry) => {
        const [walletSince, dmSince] = await Promise.all([
          this.getAddressSince(entry),
          this.getAddressDmSince(entry),
        ]);
        return { walletSince, dmSince };
      }),
    );
    for (const { walletSince, dmSince } of sinceResults) {
      if (walletSince < globalSince) globalSince = walletSince;
      if (dmSince < globalDmSince) globalDmSince = dmSince;
    }

    // Subscribe to wallet events for ALL pubkeys
    const walletFilter = new Filter();
    walletFilter.kinds = [
      EVENT_KINDS.DIRECT_MESSAGE,
      EVENT_KINDS.TOKEN_TRANSFER,
      EVENT_KINDS.PAYMENT_REQUEST,
      EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
    ];
    walletFilter['#p'] = allPubkeys;
    walletFilter.since = globalSince;

    logger.debug('Mux', `updateSubscriptions: wallet filter kinds=${walletFilter.kinds} pubkeys=[${allPubkeys.map(p => p.slice(0,16)).join(',')}] since=${globalSince}`);

    this.walletSubscriptionId = this.nostrClient.subscribe(walletFilter, {
      onEvent: (event) => {
        this.handleEvent({
          id: event.id,
          kind: event.kind,
          content: event.content,
          tags: event.tags,
          pubkey: event.pubkey,
          created_at: event.created_at,
          sig: event.sig,
        });
      },
      onEndOfStoredEvents: () => {
        logger.debug('Mux', 'Wallet subscription EOSE');
      },
      onError: (_subId, error) => {
        logger.warn('Mux', 'Wallet subscription closed by relay:', error);
        this.scheduleResubscribe();
      },
    });

    const chatFilter = new Filter();
    chatFilter.kinds = [EventKinds.GIFT_WRAP];
    chatFilter['#p'] = allPubkeys;
    // NIP-17 gift wraps have created_at randomized ±2 days for privacy.
    // Without this offset, ~50% of messages are silently dropped by the relay
    // because their randomized timestamp lands before the `since` filter.
    // Math.max(0, ...) prevents negative timestamps when globalDmSince is small.
    chatFilter.since = Math.max(0, globalDmSince - NIP17_TIMESTAMP_RANDOMIZATION);

    this.chatSubscriptionId = this.nostrClient.subscribe(chatFilter, {
      onEvent: (event) => {
        this.handleEvent({
          id: event.id,
          kind: event.kind,
          content: event.content,
          tags: event.tags,
          pubkey: event.pubkey,
          created_at: event.created_at,
          sig: event.sig,
        });
      },
      onEndOfStoredEvents: () => {
        logger.debug('Mux', 'Chat subscription EOSE');
        if (!this.chatEoseFired) {
          this.chatEoseFired = true;
          for (const handler of this.chatEoseHandlers) {
            try { handler(); } catch { /* ignore */ }
          }
        }
      },
      onError: (_subId, error) => {
        logger.warn('Mux', 'Chat subscription closed by relay:', error);
        this.scheduleResubscribe();
      },
    });

    logger.debug('Mux', `updateSubscriptions: walletSub=${this.walletSubscriptionId} chatSub=${this.chatSubscriptionId}`);

    // No application-layer healthcheck (#122). Connection-level
    // liveness is owned by the SDK's keepalive timer (one per relay
    // socket — pingIntervalMs: 15000), and relay-initiated CLOSED
    // frames flow through onError → scheduleResubscribe(). The
    // previous "no events for 60s" heuristic was prone to false
    // positives during quiet periods and an EOSE probe at this layer
    // would just duplicate what the SDK already does on the same
    // socket (#123 made the Mux share that socket).
  }

  /**
   * Schedule a re-subscription after a relay-initiated subscription closure.
   * Debounced: if both wallet and chat subscriptions fire onError in quick
   * succession, only one updateSubscriptions() call runs.
   *
   * Issue #442 caveat: if the 2 s timer ticks while the gate is
   * suppressed (during the bootstrap window), `updateSubscriptions`
   * short-circuits and the rebuild is dropped. The explicit
   * `armSubscriptions` at the end of `Sphere.initializeModules`
   * always calls `updateSubscriptions` unconditionally, so any
   * rebuild dropped here self-heals when arm fires. Outside the
   * bootstrap window the gate is open and this path is unaffected.
   */
  private scheduleResubscribe(): void {
    if (this.resubscribeTimer) return; // already scheduled
    this.resubscribeTimer = setTimeout(() => {
      this.resubscribeTimer = null;
      if (!this.isConnected()) return;
      logger.warn('Mux', 'Re-subscribing after relay-initiated subscription closure');
      this.updateSubscriptions().catch((err) => {
        logger.warn('Mux', 'Re-subscription failed:', err);
      });
    }, 2000);
  }

  /**
   * Determine 'since' timestamp for an address entry.
   */
  private async getAddressSince(entry: AddressEntry): Promise<number> {
    if (this.storage) {
      const storageKey = `${STORAGE_KEYS_GLOBAL.LAST_WALLET_EVENT_TS}_${entry.nostrPubkey.slice(0, 16)}`;
      try {
        const stored = await this.storage.get(storageKey);
        if (stored) {
          const ts = parseInt(stored, 10);
          entry.lastEventTs = ts;
          entry.fallbackSince = null;
          return ts;
        } else if (entry.fallbackSince !== null) {
          const ts = entry.fallbackSince;
          entry.lastEventTs = ts;
          entry.fallbackSince = null;
          return ts;
        }
      } catch {
        // Fall through to default
      }
    }
    return Math.floor(Date.now() / 1000);
  }

  // ===========================================================================
  // Event Routing
  // ===========================================================================

  /**
   * Route an incoming Nostr event to the correct address adapter.
   */
  private async handleEvent(event: NostrEvent): Promise<void> {
    // Dedup — bounded set with FIFO eviction. Issue #275 persists this
    // set so cross-process CLI invocations short-circuit at this gate.
    if (event.id && this.processedEventIds.has(event.id)) {
      // [#559-diag] cross-process dedup hit — the prior CLI process's
      // persisted MUX_PROCESSED_EVENT_IDS caught this replay. If this fires
      // in §3 of trader-soak, the OrbitDB Profile flush survived
      // process exit and (A.2) requires a different fix surface.
      logger.info(
        'Mux',
        `[#559-diag] dedup hit on event ${event.id.slice(0, 12)}... ` +
        `(kind=${event.kind}, total dedup set size=${this.processedEventIds.size})`,
      );
      return;
    }
    if (event.id) {
      this.processedEventIds.add(event.id);
      // FIFO half-flush — preserves the legacy "evict half on overflow"
      // behavior to avoid thrashing at the cap boundary under bursts.
      if (this.processedEventIds.size > MultiAddressTransportMux.MAX_PROCESSED_IDS) {
        const it = this.processedEventIds.values();
        for (let i = 0; i < MultiAddressTransportMux.MAX_PROCESSED_IDS / 2; i++) {
          const entry = it.next();
          if (entry.done) break;
          this.processedEventIds.delete(entry.value);
        }
      }
      // Persist asynchronously (#275). The Mux's dispatch model
      // unconditionally advances `lastEventTs` per-address, so we
      // don't need the two-tier "successfully processed vs. in-flight"
      // split that NostrTransportProvider uses. Every add is a
      // commitment to advance.
      this.schedulePersistDedup();
    }
    try {
      if (event.kind === EventKinds.GIFT_WRAP) {
        // Gift wrap (NIP-17): must try decryption with each address's keyManager
        await this.routeGiftWrap(event);
      } else {
        // Wallet events: route by #p tag
        const recipientPubkey = this.extractRecipientPubkey(event);
        if (!recipientPubkey) {
          logger.debug('Mux', 'Event has no #p tag, dropping:', event.id?.slice(0, 12));
          return;
        }

        const addressIndex = this.pubkeyToIndex.get(recipientPubkey);
        if (addressIndex === undefined) {
          logger.debug('Mux', 'Event for unknown pubkey:', recipientPubkey.slice(0, 16), 'dropping');
          return;
        }

        const entry = this.addresses.get(addressIndex);
        if (!entry) return;

        await this.dispatchWalletEvent(entry, event);
      }
    } catch (error) {
      logger.debug('Mux', 'Failed to handle event:', event.id?.slice(0, 12), error);
    }
  }

  /**
   * Extract recipient pubkey from event's #p tag.
   * Returns the first #p value that matches a known address pubkey,
   * or the first #p value if none match.
   */
  private extractRecipientPubkey(event: NostrEvent): string | null {
    const pTags = event.tags?.filter(t => t[0] === 'p');
    if (!pTags || pTags.length === 0) return null;

    // Prefer a #p tag that matches a known address
    for (const tag of pTags) {
      if (tag[1] && this.pubkeyToIndex.has(tag[1])) {
        return tag[1];
      }
    }
    // Fallback: first #p tag
    return pTags[0]?.[1] ?? null;
  }

  /**
   * Route a gift wrap event by trying decryption with each address keyManager.
   */
  private async routeGiftWrap(event: NostrEvent): Promise<void> {
    for (const entry of this.addresses.values()) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pm = NIP17.unwrap(event as any, entry.keyManager);

        // Successfully decrypted — route to this address.
        // Persist DM timestamp after successful unwrap so failed decryptions
        // do not advance the since filter and permanently skip events.
        // Use real wall-clock time, NOT event.created_at — NIP-17 gift wraps
        // randomize created_at by ±2 days for privacy, so it can be in the future.
        this.updateLastDmEventTimestamp(entry, Math.floor(Date.now() / 1000));
        logger.debug('Mux', `Gift wrap decrypted by address ${entry.index}, sender: ${pm.senderPubkey?.slice(0, 16)}`);

        // Handle self-wrap
        if (pm.senderPubkey === entry.nostrPubkey) {
          try {
            const parsed = JSON.parse(pm.content);
            if (parsed?.selfWrap && parsed.recipientPubkey) {
              // Skip self-wrapped read receipts and typing indicators (legacy bug)
              try {
                const innerParsed = typeof parsed.text === 'string' ? JSON.parse(parsed.text) : null;
                if (innerParsed?.type === 'read_receipt' || innerParsed?.type === 'typing') {
                  return;
                }
              } catch { /* not JSON inner, continue as message */ }

              // Parse inner JSON envelope (same as normal message handler)
              let selfWrapContent = parsed.text ?? '';
              let selfWrapNametag: string | undefined = parsed.senderNametag;
              try {
                const innerParsed = JSON.parse(selfWrapContent);
                if (typeof innerParsed === 'object' && innerParsed.text !== undefined) {
                  selfWrapContent = innerParsed.text;
                  selfWrapNametag = innerParsed.senderNametag || selfWrapNametag;
                }
              } catch { /* plain text */ }

              const message: IncomingMessage = {
                id: parsed.originalId || pm.eventId,
                senderTransportPubkey: pm.senderPubkey,
                senderNametag: selfWrapNametag,
                recipientTransportPubkey: parsed.recipientPubkey,
                content: selfWrapContent,
                timestamp: pm.timestamp * 1000,
                encrypted: true,
                isSelfWrap: true,
              };
              // Issue #464 — await dispatch so handler durability propagates.
              await entry.adapter.dispatchMessage(message);
              return;
            }
          } catch {
            // Not JSON self-wrap
          }
          // Skip own non-self-wrap message
          return;
        }

        // Handle read receipts
        if (isReadReceipt(pm)) {
          if (pm.replyToEventId) {
            const receipt: IncomingReadReceipt = {
              senderTransportPubkey: pm.senderPubkey,
              messageEventId: pm.replyToEventId,
              timestamp: pm.timestamp * 1000,
            };
            await entry.adapter.dispatchReadReceipt(receipt);
          }
          return;
        }

        // Handle composing indicators
        if (pm.kind === COMPOSING_INDICATOR_KIND) {
          let senderNametag: string | undefined;
          let expiresIn = 30000;
          try {
            const parsed = JSON.parse(pm.content);
            senderNametag = parsed.senderNametag || undefined;
            expiresIn = parsed.expiresIn ?? 30000;
          } catch { /* defaults */ }
          await entry.adapter.dispatchComposingIndicator({
            senderPubkey: pm.senderPubkey,
            senderNametag,
            expiresIn,
          });
          return;
        }

        // Filter control messages sent as kind-14 (legacy bug — should use dedicated kinds)
        try {
          const parsed = JSON.parse(pm.content);
          if (parsed?.type === 'read_receipt' && parsed.messageEventId) {
            const receipt: IncomingReadReceipt = {
              senderTransportPubkey: pm.senderPubkey,
              messageEventId: parsed.messageEventId,
              timestamp: pm.timestamp * 1000,
            };
            await entry.adapter.dispatchReadReceipt(receipt);
            return;
          }
          if (parsed?.type === 'typing') {
            const indicator: IncomingTypingIndicator = {
              senderTransportPubkey: pm.senderPubkey,
              senderNametag: parsed.senderNametag,
              timestamp: pm.timestamp * 1000,
            };
            await entry.adapter.dispatchTypingIndicator(indicator);
            return;
          }
          if (parsed?.senderNametag !== undefined && parsed?.expiresIn !== undefined && !parsed?.text) {
            await entry.adapter.dispatchComposingIndicator({
              senderPubkey: pm.senderPubkey,
              senderNametag: parsed.senderNametag || undefined,
              expiresIn: parsed.expiresIn ?? 30000,
            });
            return;
          }
        } catch { /* not JSON, continue */ }

        // Handle chat messages
        if (!isChatMessage(pm)) return;

        let content = pm.content;
        let senderNametag: string | undefined;
        try {
          const parsed = JSON.parse(content);
          if (typeof parsed === 'object' && parsed.text !== undefined) {
            content = parsed.text;
            senderNametag = parsed.senderNametag || undefined;
          }
        } catch { /* plain text */ }

        const message: IncomingMessage = {
          id: event.id,
          senderTransportPubkey: pm.senderPubkey,
          senderNametag,
          content,
          timestamp: pm.timestamp * 1000,
          encrypted: true,
        };

        await entry.adapter.dispatchMessage(message);
        return; // Successfully routed, stop trying other addresses
      } catch {
        // Decryption failed for this address — try next
        continue;
      }
    }
    // None could decrypt — expected for events not meant for us
    logger.debug('Mux', 'Gift wrap could not be decrypted by any address');
  }

  /**
   * Dispatch a wallet event (non-gift-wrap) to the correct address adapter.
   */
  private async dispatchWalletEvent(entry: AddressEntry, event: NostrEvent): Promise<void> {
    switch (event.kind) {
      case EVENT_KINDS.DIRECT_MESSAGE:
        // NIP-04 kind 4 is deprecated for DMs, ignore
        break;

      case EVENT_KINDS.TOKEN_TRANSFER:
        await this.handleTokenTransfer(entry, event);
        break;

      case EVENT_KINDS.PAYMENT_REQUEST:
        await this.handlePaymentRequest(entry, event);
        break;

      case EVENT_KINDS.PAYMENT_REQUEST_RESPONSE:
        await this.handlePaymentRequestResponse(entry, event);
        break;
    }

    // Update last event timestamp for this address
    if (event.created_at) {
      this.updateLastEventTimestamp(entry, event.created_at);
    }
  }

  private async handleTokenTransfer(entry: AddressEntry, event: NostrEvent): Promise<void> {
    try {
      const content = await this.decryptContent(entry, event.content, event.pubkey);
      const payload = JSON.parse(content) as TokenTransferPayload;

      const transfer: IncomingTokenTransfer = {
        id: event.id,
        senderTransportPubkey: event.pubkey,
        payload,
        timestamp: event.created_at * 1000,
      };

      // Issue #464 — await dispatch so handler durability propagates upstream.
      // The async handler (`PaymentsModule.handleIncomingTransfer`) must
      // complete its storage write before `dispatchWalletEvent` returns,
      // otherwise `fetchPendingEvents` resolves mid-write and the caller's
      // next `load()` reads stale storage. Single-coin faucet flakiness
      // (#455 → #464 root-cause) lived in this gap.
      await entry.adapter.dispatchTokenTransfer(transfer);
    } catch (err) {
      logger.debug('Mux', `Token transfer decrypt failed for address ${entry.index}:`, (err as Error)?.message?.slice(0, 50));
    }
  }

  private async handlePaymentRequest(entry: AddressEntry, event: NostrEvent): Promise<void> {
    try {
      const content = await this.decryptContent(entry, event.content, event.pubkey);
      const requestData = JSON.parse(content);

      const request: IncomingPaymentRequest = {
        id: event.id,
        senderTransportPubkey: event.pubkey,
        request: {
          requestId: requestData.requestId,
          amount: requestData.amount,
          coinId: requestData.coinId,
          message: requestData.message,
          recipientNametag: requestData.recipientNametag,
          metadata: requestData.metadata,
        },
        timestamp: event.created_at * 1000,
      };

      // Issue #464 — await dispatch (see dispatchTokenTransfer above).
      await entry.adapter.dispatchPaymentRequest(request);
    } catch (err) {
      logger.debug('Mux', `Payment request decrypt failed for address ${entry.index}:`, (err as Error)?.message?.slice(0, 50));
    }
  }

  private async handlePaymentRequestResponse(entry: AddressEntry, event: NostrEvent): Promise<void> {
    try {
      const content = await this.decryptContent(entry, event.content, event.pubkey);
      const responseData = JSON.parse(content);

      const response: IncomingPaymentRequestResponse = {
        id: event.id,
        responderTransportPubkey: event.pubkey,
        response: {
          requestId: responseData.requestId,
          responseType: responseData.responseType,
          message: responseData.message,
          transferId: responseData.transferId,
        },
        timestamp: event.created_at * 1000,
      };

      // Issue #464 — await dispatch (see dispatchTokenTransfer above).
      await entry.adapter.dispatchPaymentRequestResponse(response);
    } catch (err) {
      logger.debug('Mux', `Payment response decrypt failed for address ${entry.index}:`, (err as Error)?.message?.slice(0, 50));
    }
  }

  // ===========================================================================
  // Crypto Helpers
  // ===========================================================================

  private async decryptContent(entry: AddressEntry, content: string, senderPubkey: string): Promise<string> {
    const decrypted = await NIP04.decryptHex(
      content,
      entry.keyManager.getPrivateKeyHex(),
      senderPubkey
    );
    return this.stripContentPrefix(decrypted);
  }

  private stripContentPrefix(content: string): string {
    const prefixes = ['payment_request:', 'token_transfer:', 'payment_response:'];
    for (const prefix of prefixes) {
      if (content.startsWith(prefix)) return content.slice(prefix.length);
    }
    return content;
  }

  // ===========================================================================
  // Sending (called by adapters)
  // ===========================================================================

  /**
   * Create an encrypted event using a specific address's keyManager.
   * Used by AddressTransportAdapter for sending.
   */
  async createAndPublishEncryptedEvent(
    addressIndex: number,
    kind: number,
    content: string,
    tags: string[][],
    options?: { verify?: boolean; maxAttempts?: number; label?: string }
  ): Promise<string> {
    const entry = this.addresses.get(addressIndex);
    if (!entry) throw new SphereError('Address not registered in mux', 'NOT_INITIALIZED');
    if (!this.nostrClient) throw new SphereError('Not connected', 'NOT_INITIALIZED');

    // Extract recipient pubkey from tags
    const recipientTag = tags.find(t => t[0] === 'p');
    if (!recipientTag?.[1]) throw new SphereError('No recipient pubkey in tags', 'VALIDATION_ERROR');

    // Encrypt with this address's keyManager
    const encrypted = await NIP04.encryptHex(
      content,
      entry.keyManager.getPrivateKeyHex(),
      recipientTag[1]
    );

    // Create and sign event
    const signedEvent = NostrEventClass.create(entry.keyManager, { kind, content: encrypted, tags });
    const nostrEvent = NostrEventClass.fromJSON({
      id: signedEvent.id, kind: signedEvent.kind, content: signedEvent.content,
      tags: signedEvent.tags, pubkey: signedEvent.pubkey,
      created_at: signedEvent.created_at, sig: signedEvent.sig,
    });

    const verify = options?.verify ?? false;
    if (!verify) {
      await this.nostrClient.publishEvent(nostrEvent);
      return signedEvent.id;
    }

    // Verified publish: publish → query-back → retry.
    // Matches NostrTransportProvider.publishWithVerification() pattern.
    const maxAttempts = options?.maxAttempts ?? 3;
    const label = options?.label ?? 'event';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.nostrClient.publishEvent(nostrEvent);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Event rejected') && !msg.includes('rate') && !msg.includes('limit')) {
          throw err;
        }
        if (attempt === maxAttempts) throw err;
        logger.debug('Mux', `${label} publish attempt ${attempt} failed (${msg}), retrying...`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }

      // Verify: query relay for this event (jittered delay to reduce fingerprinting)
      await new Promise(r => setTimeout(r, 300 + Math.random() * 1200));
      try {
        const found = await this._queryEventById(signedEvent.id);
        if (found) {
          if (attempt > 1) {
            logger.debug('Mux', `${label} verified on relay after ${attempt} attempt(s)`);
          }
          return signedEvent.id;
        }
      } catch {
        if (attempt === maxAttempts) {
          logger.debug('Mux', `${label} verification query failed — accepting as best-effort`);
          return signedEvent.id;
        }
      }

      if (attempt < maxAttempts) {
        const delay = Math.min(2000 * attempt, 10000);
        logger.debug('Mux', `${label} not found on relay, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw new SphereError(
          `${label} not verified on relay after ${maxAttempts} attempts — delivery failed`,
          'TRANSPORT_ERROR',
        );
      }
    }

    return signedEvent.id;
  }

  /**
   * Query the relay for a specific event by ID.
   * Returns true if the event exists, false otherwise.
   */
  private async _queryEventById(eventId: string): Promise<boolean> {
    const client = this.nostrClient;
    if (!client) return false;
    const filter = new Filter();
    filter.ids = [eventId];
    filter.limit = 1;

    return new Promise<boolean>((resolve) => {
      let found = false;
      let subId: string | undefined;
      const timeout = setTimeout(() => {
        if (subId) { try { client.unsubscribe(subId); } catch { /* */ } }
        resolve(found);
      }, 3000);

      try {
        subId = client.subscribe(filter, {
          onEvent: () => { found = true; },
          onEndOfStoredEvents: () => {
            clearTimeout(timeout);
            if (subId) { try { client.unsubscribe(subId); } catch { /* */ } }
            resolve(found);
          },
        });
      } catch {
        clearTimeout(timeout);
        resolve(false);
      }
    });
  }

  /**
   * Create and publish a NIP-17 gift wrap message for a specific address.
   */
  async sendGiftWrap(
    addressIndex: number,
    recipientPubkey: string,
    content: string
  ): Promise<string> {
    const entry = this.addresses.get(addressIndex);
    if (!entry) throw new SphereError('Address not registered in mux', 'NOT_INITIALIZED');
    if (!this.nostrClient) throw new SphereError('Not connected', 'NOT_INITIALIZED');

    // NIP-17 requires 32-byte x-only pubkey
    const nostrRecipient = recipientPubkey.length === 66 &&
      (recipientPubkey.startsWith('02') || recipientPubkey.startsWith('03'))
      ? recipientPubkey.slice(2)
      : recipientPubkey;

    const giftWrap = NIP17.createGiftWrap(entry.keyManager, nostrRecipient, content);
    const giftWrapEvent = NostrEventClass.fromJSON(giftWrap);
    await this.nostrClient.publishEvent(giftWrapEvent);

    // Self-wrap for relay replay
    const selfPubkey = entry.keyManager.getPublicKeyHex();
    const senderNametag = entry.identity.nametag;
    const selfWrapContent = JSON.stringify({
      selfWrap: true,
      originalId: giftWrap.id,
      recipientPubkey,
      senderNametag,
      text: content,
    });
    const selfGiftWrap = NIP17.createGiftWrap(entry.keyManager, selfPubkey, selfWrapContent);
    const selfGiftWrapEvent = NostrEventClass.fromJSON(selfGiftWrap);
    this.nostrClient.publishEvent(selfGiftWrapEvent).catch((err: unknown) => {
      logger.debug('Mux', 'Self-wrap publish failed:', err);
    });

    return giftWrap.id;
  }

  /**
   * Send a NIP-17 read receipt (kind 15) for a specific address.
   */
  async sendReadReceipt(addressIndex: number, recipientPubkey: string, messageEventId: string): Promise<void> {
    const entry = this.addresses.get(addressIndex);
    if (!entry) throw new SphereError('Address not registered in mux', 'NOT_INITIALIZED');
    if (!this.nostrClient) throw new SphereError('Not connected', 'NOT_INITIALIZED');

    const nostrRecipient = recipientPubkey.length === 66 &&
      (recipientPubkey.startsWith('02') || recipientPubkey.startsWith('03'))
      ? recipientPubkey.slice(2)
      : recipientPubkey;

    const event = NIP17.createReadReceipt(entry.keyManager, nostrRecipient, messageEventId);
    const giftWrapEvent = NostrEventClass.fromJSON(event);
    await this.nostrClient.publishEvent(giftWrapEvent);
    logger.debug('Mux', `Sent read receipt for ${messageEventId} to ${nostrRecipient.slice(0, 16)}`);
  }

  /**
   * Send a composing indicator (kind 25050) gift wrap for a specific address.
   */
  async sendComposingIndicator(addressIndex: number, recipientPubkey: string, content: string): Promise<void> {
    const entry = this.addresses.get(addressIndex);
    if (!entry) throw new SphereError('Address not registered in mux', 'NOT_INITIALIZED');
    if (!this.nostrClient) throw new SphereError('Not connected', 'NOT_INITIALIZED');

    const nostrRecipient = recipientPubkey.length === 66 &&
      (recipientPubkey.startsWith('02') || recipientPubkey.startsWith('03'))
      ? recipientPubkey.slice(2)
      : recipientPubkey;

    const giftWrap = NostrTransportProvider.createCustomKindGiftWrap(entry.keyManager, nostrRecipient, content, COMPOSING_INDICATOR_KIND);
    const giftWrapEvent = NostrEventClass.fromJSON(giftWrap);
    await this.nostrClient.publishEvent(giftWrapEvent);
  }

  /**
   * Publish a raw event (e.g., identity binding, broadcast).
   */
  async publishRawEvent(addressIndex: number, kind: number, content: string, tags: string[][]): Promise<string> {
    const entry = this.addresses.get(addressIndex);
    if (!entry) throw new SphereError('Address not registered in mux', 'NOT_INITIALIZED');
    if (!this.nostrClient) throw new SphereError('Not connected', 'NOT_INITIALIZED');

    const signedEvent = NostrEventClass.create(entry.keyManager, { kind, content, tags });
    const nostrEvent = NostrEventClass.fromJSON({
      id: signedEvent.id, kind: signedEvent.kind, content: signedEvent.content,
      tags: signedEvent.tags, pubkey: signedEvent.pubkey,
      created_at: signedEvent.created_at, sig: signedEvent.sig,
    });
    await this.nostrClient.publishEvent(nostrEvent);
    return signedEvent.id;
  }

  // ===========================================================================
  // Resolve Methods (delegates to inner — these are stateless relay queries)
  // ===========================================================================

  /**
   * Get the NostrClient for resolve operations.
   * Adapters use this for resolve*, publishIdentityBinding, etc.
   */
  getNostrClient(): NostrClient | null {
    return this.nostrClient;
  }

  /**
   * Get keyManager for a specific address (used by adapters for resolve/binding).
   */
  getKeyManager(addressIndex: number): NostrKeyManager | null {
    return this.addresses.get(addressIndex)?.keyManager ?? null;
  }

  /**
   * Get identity for a specific address.
   */
  getIdentity(addressIndex: number): FullIdentity | null {
    return this.addresses.get(addressIndex)?.identity ?? null;
  }

  // ===========================================================================
  // Event timestamp persistence
  // ===========================================================================

  private updateLastEventTimestamp(entry: AddressEntry, createdAt: number): void {
    if (!this.storage) return;
    if (createdAt <= entry.lastEventTs) return;

    entry.lastEventTs = createdAt;
    const storageKey = `${STORAGE_KEYS_GLOBAL.LAST_WALLET_EVENT_TS}_${entry.nostrPubkey.slice(0, 16)}`;

    this.storage.set(storageKey, createdAt.toString()).catch(err => {
      logger.debug('Mux', 'Failed to save last event timestamp:', err);
    });
  }

  private updateLastDmEventTimestamp(entry: AddressEntry, createdAt: number): void {
    if (!this.storage) return;
    if (createdAt <= entry.lastDmEventTs) return;

    entry.lastDmEventTs = createdAt;
    const storageKey = `${STORAGE_KEYS_GLOBAL.LAST_DM_EVENT_TS}_${entry.nostrPubkey.slice(0, 16)}`;

    this.storage.set(storageKey, createdAt.toString()).catch(err => {
      logger.debug('Mux', 'Failed to save last DM event timestamp:', err);
    });
  }

  private async getAddressDmSince(entry: AddressEntry): Promise<number> {
    if (this.storage) {
      const storageKey = `${STORAGE_KEYS_GLOBAL.LAST_DM_EVENT_TS}_${entry.nostrPubkey.slice(0, 16)}`;
      try {
        const stored = await this.storage.get(storageKey);
        const parsed = stored ? parseInt(stored, 10) : NaN;
        if (Number.isFinite(parsed)) {
          entry.lastDmEventTs = parsed;
          entry.fallbackDmSince = null; // Stored value takes priority
          return parsed;
        } else if (entry.fallbackDmSince !== null) {
          const ts = entry.fallbackDmSince;
          entry.lastDmEventTs = ts;
          entry.fallbackDmSince = null; // Consume once
          return ts;
        }
      } catch {
        if (entry.fallbackDmSince !== null) {
          const ts = entry.fallbackDmSince;
          entry.lastDmEventTs = ts;
          entry.fallbackDmSince = null;
          return ts;
        }
      }
    } else if (entry.fallbackDmSince !== null) {
      const ts = entry.fallbackDmSince;
      entry.lastDmEventTs = ts;
      entry.fallbackDmSince = null;
      return ts;
    }
    // No storage, no fallback — start from now (no historical replay)
    return Math.floor(Date.now() / 1000);
  }

  // ===========================================================================
  // Mux-level event system
  // ===========================================================================

  onTransportEvent(callback: TransportEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  onChatReady(handler: () => void): () => void {
    if (this.chatEoseFired) {
      try { handler(); } catch { /* ignore */ }
      return () => {};
    }
    this.chatEoseHandlers.push(handler);
    return () => {
      const idx = this.chatEoseHandlers.indexOf(handler);
      if (idx >= 0) this.chatEoseHandlers.splice(idx, 1);
    };
  }

  private emitEvent(event: TransportEvent): void {
    for (const cb of this.eventCallbacks) {
      try { cb(event); } catch { /* ignore */ }
    }
    // Also forward to all adapters
    for (const entry of this.addresses.values()) {
      entry.adapter.emitTransportEvent(event);
    }
  }

  // ===========================================================================
  // Dedup Management
  // ===========================================================================

  /**
   * Clear processed event IDs.
   *
   * Currently unused — kept as part of the public surface for future
   * forced-reset scenarios (e.g., a hypothetical "wipe dedup but keep
   * connection" path). The Mux's dedup set is shared across all
   * addresses, so address add/remove does NOT need to clear it — they
   * legitimately share the same relay event stream. `Sphere.clear()`
   * handles the full-wipe case via `storage.clear()`, which
   * implicitly removes the persisted `MUX_PROCESSED_EVENT_IDS` key.
   *
   * Issue #275: when called, also cancels any pending persist timer
   * and resets `dedupHydrated` so a follow-up `updateSubscriptions`
   * re-hydrates from storage.
   */
  clearProcessedEvents(): void {
    this.processedEventIds.clear();
    if (this.persistDedupTimer) {
      clearTimeout(this.persistDedupTimer);
      this.persistDedupTimer = null;
    }
    this.dedupHydrated = false;
  }

  /**
   * Issue #275 — hydrate `processedEventIds` from storage. Idempotent;
   * subsequent calls are no-ops once `dedupHydrated` is true. Failure
   * modes (storage throw, JSON parse error, non-array) degrade to
   * "start fresh" — the Mux still functions, just pays the legacy
   * re-dispatch cost once until the next debounce flush repopulates.
   */
  private async hydrateProcessedDedup(): Promise<void> {
    if (this.dedupHydrated) return;
    if (!this.storage) {
      this.dedupHydrated = true;
      return;
    }
    try {
      const raw = await this.storage.get(STORAGE_KEYS_GLOBAL.MUX_PROCESSED_EVENT_IDS);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const id of parsed) {
            if (typeof id === 'string' && id.length > 0) {
              this.processedEventIds.add(id);
            }
          }
        }
      }
    } catch (err) {
      logger.debug('Mux', '[#275] hydrateProcessedDedup parse/read failed:', err);
    }
    this.dedupHydrated = true;
    logger.debug(
      'Mux',
      `[#275] Mux dedup hydrated: ${this.processedEventIds.size} event IDs`,
    );
    // [#559-diag] Promote post-hydration size to INFO so it appears in
    // production CLI logs without DEBUG_LOG=1. Discriminator for #559:
    //   hydrated=0 in §3 SET_STRATEGY → cross-process flush is failing
    //     (OrbitDB Profile durability — see #234/#239/#266/#268 family)
    //   hydrated=N>0 + no dedup-hit log → events arrive via a path that
    //     bypasses the Mux handleEvent gate (look at outer
    //     NostrTransportProvider.processedEventIds and fetchPendingEvents).
    logger.info(
      'Mux',
      `[#559-diag] hydrated: ${this.processedEventIds.size} event IDs ` +
      `(storage=${this.storage ? 'present' : 'absent'})`,
    );
  }

  /**
   * Issue #275 — schedule a debounced write of `processedEventIds`.
   * Coalesces a burst of EOSE-replay arrivals into a single storage
   * transaction. Subsequent calls within the debounce window are
   * no-ops (timer already armed).
   */
  private schedulePersistDedup(): void {
    if (!this.storage) return;
    if (this.persistDedupTimer) return;
    this.persistDedupTimer = setTimeout(() => {
      this.persistDedupTimer = null;
      this.persistDedupNow().catch((err) => {
        logger.debug('Mux', '[#275] Persisted dedup write failed (will retry on next mark):', err);
      });
    }, LIMITS.PROCESSED_EVENT_IDS_FLUSH_MS);
  }

  /**
   * Issue #275 — write the persistent dedup set to storage. Serialized
   * via `persistDedupInFlight` so concurrent timer fires and the
   * disconnect-flush don't race on the underlying KV write.
   */
  private async persistDedupNow(): Promise<void> {
    if (!this.storage) return;
    if (this.persistDedupInFlight) {
      await this.persistDedupInFlight.catch(() => undefined);
    }
    const inFlight = this.doPersistDedup();
    this.persistDedupInFlight = inFlight;
    try {
      await inFlight;
    } finally {
      if (this.persistDedupInFlight === inFlight) {
        this.persistDedupInFlight = null;
      }
    }
  }

  private async doPersistDedup(): Promise<void> {
    if (!this.storage) return;
    const ids = Array.from(this.processedEventIds);
    try {
      await this.storage.set(STORAGE_KEYS_GLOBAL.MUX_PROCESSED_EVENT_IDS, JSON.stringify(ids));
    } catch (err) {
      logger.debug('Mux', '[#275] doPersistDedup write failed:', err);
    }
  }

  /**
   * Get the storage adapter (for adapters that need it).
   */
  getStorage(): TransportStorageAdapter | null {
    return this.storage;
  }

  /**
   * Get the UUID generator.
   */
  getUUIDGenerator(): UUIDGenerator {
    return this.config.generateUUID;
  }
}

// =============================================================================
// AddressTransportAdapter
// =============================================================================

/**
 * Lightweight TransportProvider implementation for a single address.
 * Does NOT own a WebSocket — delegates to MultiAddressTransportMux.
 * Each per-address module (PaymentsModule, CommunicationsModule) uses one of these.
 */
export class AddressTransportAdapter implements TransportProvider {
  readonly id: string;
  readonly name: string;
  readonly type = 'p2p' as const;
  readonly description: string;

  private mux: MultiAddressTransportMux;
  private addressIndex: number;
  private identity: FullIdentity;
  private resolveDelegate: TransportProvider | null;

  // Per-address handler sets
  private messageHandlers: Set<MessageHandler> = new Set();
  private transferHandlers: Set<TokenTransferHandler> = new Set();
  private paymentRequestHandlers: Set<PaymentRequestHandler> = new Set();
  private paymentRequestResponseHandlers: Set<PaymentRequestResponseHandler> = new Set();
  private readReceiptHandlers: Set<ReadReceiptHandler> = new Set();
  private typingIndicatorHandlers: Set<TypingIndicatorHandler> = new Set();
  private composingHandlers: Set<ComposingHandler> = new Set();
  private instantSplitBundleHandlers: Set<InstantSplitBundleHandler> = new Set();
  private broadcastHandlers: Map<string, Set<BroadcastHandler>> = new Map();
  private eventCallbacks: Set<TransportEventCallback> = new Set();
  private pendingMessages: IncomingMessage[] = [];
  // Issue #223 — cross-process Nostr delivery race. The relay's REQ response
  // can land between `mux.addAddress()` (which subscribes) and
  // `PaymentsModule.initialize()` (which calls `onTokenTransfer`). Without a
  // queue, `dispatchTokenTransfer` would iterate an empty handler set and
  // silently drop the event. Mirror the pre-existing `pendingMessages` pattern
  // for token transfers and payment-request / payment-response events.
  private pendingTransfers: IncomingTokenTransfer[] = [];
  private pendingPaymentRequests: IncomingPaymentRequest[] = [];
  private pendingPaymentRequestResponses: IncomingPaymentRequestResponse[] = [];
  private chatEoseHandlers: Array<() => void> = [];

  // Issue #464 — drain promise tracker. When `onTokenTransfer` (or sibling
  // `on*` registrations) drains its pending buffer, it does so via an async
  // handler. Pre-#464 the drain iterated synchronously and dropped the
  // returned Promise — a future `dispatchTokenTransfer` or
  // `fetchPendingEvents` could resolve while drained-event writes were
  // still in flight. We track every drain as a Promise here so that any
  // ordering-sensitive caller (in particular `dispatchTokenTransfer` and
  // the mux's `fetchPendingEvents`) can `await flushPendingDrains()`
  // before observing storage state. `Promise.allSettled` keeps fault
  // isolation across handlers and across drains. Completed drains are
  // pruned lazily inside `flushPendingDrains`.
  private inFlightDrains: Set<Promise<unknown>> = new Set();

  constructor(
    mux: MultiAddressTransportMux,
    addressIndex: number,
    identity: FullIdentity,
    resolveDelegate?: TransportProvider | null,
  ) {
    this.mux = mux;
    this.addressIndex = addressIndex;
    this.identity = identity;
    this.resolveDelegate = resolveDelegate ?? null;
    this.id = `nostr-addr-${addressIndex}`;
    this.name = `Nostr Transport (address ${addressIndex})`;
    this.description = `P2P messaging for address index ${addressIndex}`;
  }

  // ===========================================================================
  // BaseProvider — delegates to mux
  // ===========================================================================

  async connect(): Promise<void> {
    await this.mux.connect();
  }

  async disconnect(): Promise<void> {
    // Individual adapters don't disconnect the shared transport
    // Use mux.disconnect() to close the connection
  }

  isConnected(): boolean {
    return this.mux.isConnected();
  }

  getStatus(): ProviderStatus {
    return this.mux.getStatus();
  }

  // ===========================================================================
  // Identity (no-op — mux manages identity via addAddress)
  // ===========================================================================

  async setIdentity(identity: FullIdentity): Promise<void> {
    this.identity = identity;
    // Mux handles re-subscription
    await this.mux.addAddress(this.addressIndex, identity);
  }

  // ===========================================================================
  // Sending — delegates to mux with this address's keyManager
  // ===========================================================================

  async sendMessage(recipientPubkey: string, content: string): Promise<string> {
    const senderNametag = this.identity.nametag;
    const wrappedContent = senderNametag
      ? JSON.stringify({ senderNametag, text: content })
      : content;

    return this.mux.sendGiftWrap(this.addressIndex, recipientPubkey, wrappedContent);
  }

  async sendTokenTransfer(recipientPubkey: string, payload: TokenTransferPayload): Promise<string> {
    const content = 'token_transfer:' + JSON.stringify(payload);
    const uniqueD = `token-transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.mux.createAndPublishEncryptedEvent(
      this.addressIndex,
      EVENT_KINDS.TOKEN_TRANSFER,
      content,
      [['p', recipientPubkey], ['d', uniqueD], ['type', 'token_transfer']],
      { verify: true, maxAttempts: 3, label: 'token_transfer' }
    );
  }

  async sendPaymentRequest(recipientPubkey: string, payload: PaymentRequestPayload): Promise<string> {
    const requestId = this.mux.getUUIDGenerator()();
    const amount = typeof payload.amount === 'bigint' ? payload.amount.toString() : payload.amount;
    const requestContent = {
      requestId,
      amount,
      coinId: payload.coinId,
      message: payload.message,
      recipientNametag: payload.recipientNametag,
      deadline: Date.now() + 5 * 60 * 1000,
    };
    const content = 'payment_request:' + JSON.stringify(requestContent);
    const tags: string[][] = [
      ['p', recipientPubkey],
      ['type', 'payment_request'],
      ['amount', amount],
    ];
    if (payload.recipientNametag) {
      tags.push(['recipient', payload.recipientNametag]);
    }
    return this.mux.createAndPublishEncryptedEvent(
      this.addressIndex,
      EVENT_KINDS.PAYMENT_REQUEST,
      content,
      tags
    );
  }

  async sendPaymentRequestResponse(
    recipientPubkey: string,
    response: PaymentRequestResponsePayload
  ): Promise<string> {
    const content = 'payment_response:' + JSON.stringify(response);
    return this.mux.createAndPublishEncryptedEvent(
      this.addressIndex,
      EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
      content,
      [['p', recipientPubkey], ['type', 'payment_response']]
    );
  }

  async sendReadReceipt(recipientPubkey: string, messageEventId: string): Promise<void> {
    // Read receipts must use NIP-17 kind 15 (not regular gift wrap kind 14)
    await this.mux.sendReadReceipt(this.addressIndex, recipientPubkey, messageEventId);
  }

  async sendTypingIndicator(recipientPubkey: string): Promise<void> {
    // Typing indicators use composing kind 25050
    const content = JSON.stringify({
      type: 'typing',
      senderNametag: this.identity.nametag,
    });
    await this.mux.sendComposingIndicator(this.addressIndex, recipientPubkey, content);
  }

  async sendComposingIndicator(recipientPubkey: string, content: string): Promise<void> {
    // Composing indicators must use kind 25050 (not regular gift wrap kind 14)
    await this.mux.sendComposingIndicator(this.addressIndex, recipientPubkey, content);
  }

  async sendInstantSplitBundle(
    recipientPubkey: string,
    bundle: InstantSplitBundlePayload
  ): Promise<string> {
    const content = 'token_transfer:' + JSON.stringify({
      type: 'instant_split',
      ...bundle,
    });
    const uniqueD = `instant-split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return this.mux.createAndPublishEncryptedEvent(
      this.addressIndex,
      EVENT_KINDS.TOKEN_TRANSFER,
      content,
      [['p', recipientPubkey], ['d', uniqueD], ['type', 'instant_split']]
    );
  }

  // ===========================================================================
  // Subscription handlers — per-address
  // ===========================================================================
  //
  // Issue #464 — drain path. The `on*(handler)` registration returns the
  // unsubscribe function synchronously (legacy contract), but the actual
  // drain of any buffered events runs asynchronously and is tracked in
  // `inFlightDrains`. `flushPendingDrains()` / `dispatchTokenTransfer`
  // (and siblings) await those tracked promises before observing storage
  // state, so a caller that does `onTokenTransfer(h); await flushPendingDrains()`
  // sees the drain settled.
  //
  // The drain buffer is snapshotted and cleared atomically before the
  // async fan-out — events arriving during the drain take the live
  // dispatch path (`transferHandlers.size > 0` is true now) and won't
  // double-buffer.

  /**
   * Track an async drain so ordering-sensitive callers can await it.
   * Auto-removes itself on settle.
   */
  private trackDrain(p: Promise<unknown>): void {
    this.inFlightDrains.add(p);
    p.finally(() => { this.inFlightDrains.delete(p); }).catch(() => { /* tracked */ });
  }

  /**
   * Await all in-flight drains for this adapter. Used by the mux's
   * `fetchPendingEvents` to guarantee that a `receive()` call sees the
   * effects of any drain triggered by handler registration during init.
   */
  async flushPendingDrains(): Promise<void> {
    if (this.inFlightDrains.size === 0) return;
    // Snapshot — new drains added during settle won't block this call.
    const snapshot = Array.from(this.inFlightDrains);
    await Promise.allSettled(snapshot);
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    // Flush pending — async drain tracked for `flushPendingDrains`.
    if (this.pendingMessages.length > 0) {
      const pending = this.pendingMessages;
      this.pendingMessages = [];
      this.trackDrain((async () => {
        for (const msg of pending) {
          try { await handler(msg); }
          catch (e) { logger.debug('MuxAdapter', 'Pending message drain error:', e); }
        }
      })());
    }
    return () => this.messageHandlers.delete(handler);
  }

  onTokenTransfer(handler: TokenTransferHandler): () => void {
    this.transferHandlers.add(handler);
    // Issue #223 — drain pending transfers queued before any handler existed.
    // Issue #464 — drain is async-aware and tracked via `inFlightDrains`.
    if (this.pendingTransfers.length > 0) {
      const pending = this.pendingTransfers;
      this.pendingTransfers = [];
      this.trackDrain((async () => {
        for (const transfer of pending) {
          try { await handler(transfer); }
          catch (e) { logger.debug('MuxAdapter', 'Pending transfer drain error:', e); }
        }
      })());
    }
    return () => this.transferHandlers.delete(handler);
  }

  onPaymentRequest(handler: PaymentRequestHandler): () => void {
    this.paymentRequestHandlers.add(handler);
    // Issue #223 — drain pending payment requests queued before any handler existed.
    if (this.pendingPaymentRequests.length > 0) {
      const pending = this.pendingPaymentRequests;
      this.pendingPaymentRequests = [];
      this.trackDrain((async () => {
        for (const request of pending) {
          try { await handler(request); }
          catch (e) { logger.debug('MuxAdapter', 'Pending payment request drain error:', e); }
        }
      })());
    }
    return () => this.paymentRequestHandlers.delete(handler);
  }

  onPaymentRequestResponse(handler: PaymentRequestResponseHandler): () => void {
    this.paymentRequestResponseHandlers.add(handler);
    // Issue #223 — drain pending payment responses queued before any handler existed.
    if (this.pendingPaymentRequestResponses.length > 0) {
      const pending = this.pendingPaymentRequestResponses;
      this.pendingPaymentRequestResponses = [];
      this.trackDrain((async () => {
        for (const response of pending) {
          try { await handler(response); }
          catch (e) { logger.debug('MuxAdapter', 'Pending payment response drain error:', e); }
        }
      })());
    }
    return () => this.paymentRequestResponseHandlers.delete(handler);
  }

  onReadReceipt(handler: ReadReceiptHandler): () => void {
    this.readReceiptHandlers.add(handler);
    return () => this.readReceiptHandlers.delete(handler);
  }

  onTypingIndicator(handler: TypingIndicatorHandler): () => void {
    this.typingIndicatorHandlers.add(handler);
    return () => this.typingIndicatorHandlers.delete(handler);
  }

  onComposing(handler: ComposingHandler): () => void {
    this.composingHandlers.add(handler);
    return () => this.composingHandlers.delete(handler);
  }

  onInstantSplitReceived(handler: InstantSplitBundleHandler): () => void {
    this.instantSplitBundleHandlers.add(handler);
    return () => this.instantSplitBundleHandlers.delete(handler);
  }

  subscribeToBroadcast(tags: string[], handler: BroadcastHandler): () => void {
    const key = tags.sort().join(':');
    if (!this.broadcastHandlers.has(key)) {
      this.broadcastHandlers.set(key, new Set());
    }
    this.broadcastHandlers.get(key)!.add(handler);
    return () => this.broadcastHandlers.get(key)?.delete(handler);
  }

  async publishBroadcast(content: string, tags?: string[]): Promise<string> {
    // Broadcasts are not encrypted, use raw event
    const eventTags: string[][] = tags ? tags.map(t => ['t', t]) : [];
    return this.mux.publishRawEvent(this.addressIndex, 30023, content, eventTags);
  }

  // ===========================================================================
  // Resolve methods — delegate to original NostrTransportProvider
  // These are stateless relay queries, shared across all addresses
  // ===========================================================================

  async resolve(identifier: string): Promise<PeerInfo | null> {
    return this.resolveDelegate?.resolve?.(identifier) ?? null;
  }

  async resolveNametag(nametag: string): Promise<string | null> {
    return this.resolveDelegate?.resolveNametag?.(nametag) ?? null;
  }

  async resolveNametagInfo(nametag: string): Promise<PeerInfo | null> {
    return this.resolveDelegate?.resolveNametagInfo?.(nametag) ?? null;
  }

  async resolveAddressInfo(address: string): Promise<PeerInfo | null> {
    return this.resolveDelegate?.resolveAddressInfo?.(address) ?? null;
  }

  async resolveTransportPubkeyInfo(transportPubkey: string): Promise<PeerInfo | null> {
    return this.resolveDelegate?.resolveTransportPubkeyInfo?.(transportPubkey) ?? null;
  }

  async discoverAddresses(transportPubkeys: string[]): Promise<PeerInfo[]> {
    return this.resolveDelegate?.discoverAddresses?.(transportPubkeys) ?? [];
  }

  async recoverNametag(): Promise<string | null> {
    // recoverNametag is identity-specific — uses the adapter's keyManager
    // For now, delegate to original transport (which must have correct identity set)
    return this.resolveDelegate?.recoverNametag?.() ?? null;
  }

  async publishIdentityBinding(
    chainPubkey: string,
    l1Address: string,
    directAddress: string,
    nametag?: string,
  ): Promise<boolean> {
    return this.resolveDelegate?.publishIdentityBinding?.(chainPubkey, l1Address, directAddress, nametag) ?? false;
  }

  // ===========================================================================
  // Relay Management — delegates to mux
  // ===========================================================================

  getRelays(): string[] { return this.mux.getRelays(); }
  getConnectedRelays(): string[] { return this.mux.getConnectedRelays(); }
  async addRelay(relayUrl: string): Promise<boolean> { return this.mux.addRelay(relayUrl); }
  async removeRelay(relayUrl: string): Promise<boolean> { return this.mux.removeRelay(relayUrl); }
  hasRelay(relayUrl: string): boolean { return this.mux.hasRelay(relayUrl); }
  isRelayConnected(relayUrl: string): boolean { return this.mux.isRelayConnected(relayUrl); }

  setFallbackSince(sinceSeconds: number): void {
    this.mux.setFallbackSince(this.addressIndex, sinceSeconds);
  }

  setFallbackDmSince(sinceSeconds: number): void {
    this.mux.setFallbackDmSince(this.addressIndex, sinceSeconds);
  }

  async fetchPendingEvents(): Promise<void> {
    // Issue #223 — backstop for cases where the persistent subscription
    // missed events (e.g. relay disconnect/reconnect, or — in older builds
    // before the pending-queue fix — race between subscribe and handler
    // registration). Delegates to the mux's bounded one-shot fetch which
    // walks the same handleEvent dispatch chain (mux-level dedup prevents
    // double-processing with the live subscription).
    await this.mux.fetchPendingEvents();
  }

  /**
   * Issue #442 — delegate to the underlying mux. Exposed on the adapter so
   * consumers holding only an `AddressTransportAdapter` reference (the
   * `TransportProvider` returned to PaymentsModule / CommunicationsModule)
   * can also gate subscription arming through the same API shape as
   * `NostrTransportProvider` (issue #423).
   *
   * Note: the gate is mux-wide, NOT per-adapter — calling
   * `armSubscriptions` on one adapter opens the relay sub for every tracked
   * address. Sphere bootstrap is the only intended caller; module code
   * should not touch this.
   */
  suppressSubscriptions(): void {
    this.mux.suppressSubscriptions();
  }

  async armSubscriptions(): Promise<void> {
    await this.mux.armSubscriptions();
  }

  isSubscriptionsArmed(): boolean {
    return this.mux.isSubscriptionsArmed();
  }

  onChatReady(handler: () => void): () => void {
    return this.mux.onChatReady(handler);
  }

  // ===========================================================================
  // Dispatch methods — called by MultiAddressTransportMux to route events
  // ===========================================================================
  //
  // Issue #464 — dispatch contract MUST propagate handler durability.
  //
  // PaymentsModule.handleIncomingTransfer is async; before #464 the
  // dispatcher iterated handlers synchronously (`handler(transfer);`),
  // discarded the returned Promise, and returned. The synchronous
  // `try/catch` only caught synchronous throws — async rejections silently
  // resolved into unhandled-rejection territory. Worse, the caller of
  // `dispatchTokenTransfer` (in particular `fetchPendingEvents` via
  // `handleTokenTransfer`) saw the dispatch return immediately and
  // happily resolved its outer Promise BEFORE the handler had finished
  // writing the token to storage. The next caller step (typically
  // `PaymentsModule.load()`) then raced against an in-flight `addToken`
  // and roughly half the time observed empty storage.
  //
  // Fix: every dispatch method is now `async` and uses `Promise.allSettled`
  // to await every handler invocation before resolving. The
  // `allSettled` (not `Promise.all`) choice preserves the per-handler
  // fault-isolation guarantee — a rejection in one handler must not
  // prevent the remaining handlers from running. Sync handlers (e.g.
  // `MessageHandler` returns `void`) `await` to a no-op via microtask;
  // the per-dispatch cost is one microtask which is negligible relative
  // to the handler workload.
  //
  // Upstream call sites (`handleTokenTransfer`, `handlePaymentRequest`,
  // gift-wrap path) MUST `await` the dispatch — see those methods
  // above for the awaited calls.

  async dispatchMessage(message: IncomingMessage): Promise<void> {
    if (this.messageHandlers.size === 0) {
      this.pendingMessages.push(message);
      return;
    }
    await Promise.allSettled(
      Array.from(this.messageHandlers).map(async (h) => {
        try { await h(message); }
        catch (e) { logger.debug('MuxAdapter', 'Message handler error:', e); }
      }),
    );
  }

  async dispatchTokenTransfer(transfer: IncomingTokenTransfer): Promise<void> {
    // Issue #223 — queue if no handler is registered yet. The relay can push
    // events between mux.addAddress (which subscribes) and PaymentsModule.
    // initialize (which calls onTokenTransfer); without the queue this fires
    // into an empty Set and the event is lost. Mirrors the dispatchMessage /
    // pendingMessages pattern.
    if (this.transferHandlers.size === 0) {
      this.pendingTransfers.push(transfer);
      return;
    }
    // Issue #464 — the CRITICAL site. PaymentsModule.handleIncomingTransfer
    // is `async`; awaiting here closes the gap between `fetchPendingEvents`
    // resolving and the handler's storage write completing.
    await Promise.allSettled(
      Array.from(this.transferHandlers).map(async (h) => {
        try { await h(transfer); }
        catch (e) { logger.debug('MuxAdapter', 'Transfer handler error:', e); }
      }),
    );
  }

  async dispatchPaymentRequest(request: IncomingPaymentRequest): Promise<void> {
    if (this.paymentRequestHandlers.size === 0) {
      this.pendingPaymentRequests.push(request);
      return;
    }
    await Promise.allSettled(
      Array.from(this.paymentRequestHandlers).map(async (h) => {
        try { await h(request); }
        catch (e) { logger.debug('MuxAdapter', 'Payment request handler error:', e); }
      }),
    );
  }

  async dispatchPaymentRequestResponse(response: IncomingPaymentRequestResponse): Promise<void> {
    if (this.paymentRequestResponseHandlers.size === 0) {
      this.pendingPaymentRequestResponses.push(response);
      return;
    }
    await Promise.allSettled(
      Array.from(this.paymentRequestResponseHandlers).map(async (h) => {
        try { await h(response); }
        catch (e) { logger.debug('MuxAdapter', 'Payment response handler error:', e); }
      }),
    );
  }

  async dispatchReadReceipt(receipt: IncomingReadReceipt): Promise<void> {
    await Promise.allSettled(
      Array.from(this.readReceiptHandlers).map(async (h) => {
        try { await h(receipt); }
        catch (e) { logger.debug('MuxAdapter', 'Read receipt handler error:', e); }
      }),
    );
  }

  async dispatchTypingIndicator(indicator: IncomingTypingIndicator): Promise<void> {
    await Promise.allSettled(
      Array.from(this.typingIndicatorHandlers).map(async (h) => {
        try { await h(indicator); }
        catch (e) { logger.debug('MuxAdapter', 'Typing handler error:', e); }
      }),
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async dispatchComposingIndicator(indicator: any): Promise<void> {
    await Promise.allSettled(
      Array.from(this.composingHandlers).map(async (h) => {
        try { await h(indicator); }
        catch (e) { logger.debug('MuxAdapter', 'Composing handler error:', e); }
      }),
    );
  }

  async dispatchInstantSplitBundle(bundle: IncomingInstantSplitBundle): Promise<void> {
    await Promise.allSettled(
      Array.from(this.instantSplitBundleHandlers).map(async (h) => {
        try { await h(bundle); }
        catch (e) { logger.debug('MuxAdapter', 'Instant split handler error:', e); }
      }),
    );
  }

  emitTransportEvent(event: TransportEvent): void {
    for (const cb of this.eventCallbacks) {
      try { cb(event); } catch { /* ignore */ }
    }
  }
}
