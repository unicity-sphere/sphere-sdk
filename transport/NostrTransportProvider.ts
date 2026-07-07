/**
 * Nostr Transport Provider
 * Platform-independent implementation using Nostr protocol for P2P messaging
 *
 * Uses @unicitylabs/nostr-js-sdk for:
 * - Real secp256k1 event signing
 * - NIP-04 encryption/decryption
 * - Event ID calculation
 * - NostrClient for reliable connection management (ping, reconnect, NIP-42)
 *
 * WebSocket is injected via factory for cross-platform support
 */

import { Buffer } from 'buffer';
import { sha256 as sha256Noble } from '@noble/hashes/sha2.js';
import {
  NostrKeyManager,
  NIP04,
  NIP17,
  NIP44,
  Event as NostrEventClass,
  EventKinds,
  decryptNametag,
  NostrClient,
  Filter,
  isChatMessage,
  isReadReceipt,
} from '@unicitylabs/nostr-js-sdk';
import type { BindingInfo } from '@unicitylabs/nostr-js-sdk';
import {
  SUPPORTED_WIRE_PROTOCOLS,
  SUPPORTED_ASSET_KINDS,
} from './transport-provider';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { logger } from '../core/logger';
import { hexToBytes as strictHexToBytes } from '../core/hex';
import type { ProviderStatus, FullIdentity } from '../types';
import { SphereError } from '../core/errors';
import type {
  TransportProvider,
  MessageHandler,
  SendMessageOptions,
  ComposingHandler,
  TokenTransferHandler,
  BroadcastHandler,
  PaymentRequestHandler,
  PaymentRequestResponseHandler,
  IncomingMessage,
  IncomingTokenTransfer,
  IncomingBroadcast,
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
} from './transport-provider';
import type { WebSocketFactory, UUIDGenerator } from './websocket';
import { defaultUUIDGenerator } from './websocket';
import {
  DEFAULT_NOSTR_RELAYS,
  LIMITS,
  NOSTR_EVENT_KINDS,
  STORAGE_KEYS_GLOBAL,
  TIMEOUTS,
} from '../constants';
import { isUxfTransferPayload } from '../extensions/uxf/types/uxf-transfer';
import { encodeTransferPayload, decodeTransferPayload } from '../extensions/uxf/bundle/transfer-payload';

// =============================================================================
// Configuration
// =============================================================================

/**
 * Minimal key-value storage interface for transport persistence.
 * Used to persist the last processed event timestamp across sessions.
 */
export interface TransportStorageAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface NostrTransportProviderConfig {
  /** Nostr relay URLs */
  relays?: string[];
  /** Connection timeout (ms) */
  timeout?: number;
  /** Auto-reconnect on disconnect */
  autoReconnect?: boolean;
  /** Reconnect delay (ms) */
  reconnectDelay?: number;
  /** Max reconnect attempts */
  maxReconnectAttempts?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** WebSocket factory (required for platform support) */
  createWebSocket: WebSocketFactory;
  /** UUID generator (optional, defaults to crypto.randomUUID) */
  generateUUID?: UUIDGenerator;
  /** Optional storage adapter for persisting subscription timestamps */
  storage?: TransportStorageAdapter;
}

const COMPOSING_INDICATOR_KIND = 25050;
const TIMESTAMP_RANDOMIZATION = 2 * 24 * 60 * 60;

// Alias for backward compatibility
const EVENT_KINDS = NOSTR_EVENT_KINDS;

// =============================================================================
// Implementation
// =============================================================================

export class NostrTransportProvider implements TransportProvider {
  readonly id = 'nostr';
  readonly name = 'Nostr Transport';
  readonly type = 'p2p' as const;
  readonly description = 'P2P messaging via Nostr protocol';

  private config: Required<Omit<NostrTransportProviderConfig, 'createWebSocket' | 'generateUUID' | 'storage'>> & {
    createWebSocket: WebSocketFactory;
    generateUUID: UUIDGenerator;
  };
  private storage: TransportStorageAdapter | null = null;
  /** In-memory max event timestamp to avoid read-before-write races in updateLastEventTimestamp. */
  private lastEventTs: number = 0;
  /** In-memory max DM (gift-wrap) event timestamp. */
  private lastDmEventTs: number = 0;
  /** Fallback 'since' timestamp for first-time address subscriptions (consumed once). */
  private fallbackSince: number | null = null;
  /** Fallback 'since' timestamp for DM (gift-wrap) subscriptions (consumed once). */
  private fallbackDmSince: number | null = null;
  private identity: FullIdentity | null = null;
  private keyManager: NostrKeyManager | null = null;
  private status: ProviderStatus = 'disconnected';

  // NostrClient from nostr-js-sdk handles all WebSocket management,
  // keepalive pings, reconnection, and NIP-42 authentication
  private nostrClient: NostrClient | null = null;
  private mainSubscriptionId: string | null = null;

  // Event handlers — two-tier dedup (issue #275).
  //
  // `processedEventIds` is the PERSISTED set of event IDs that we have
  // successfully processed (i.e., the wallet cursor advanced past them).
  // It is hydrated from KV storage on connect/fetchPendingEvents so
  // cross-process CLI invocations do not re-walk the relay backlog. The
  // §C soak forensics in issue #275 showed 169 dispatches across 15
  // unique event IDs because this set previously lived in-process only
  // — 71.5% of §C wall-clock was wasted on duplicate dispatch.
  //
  // We MUST NOT add to this set before the event handler completes
  // successfully: doing so would mask the at-least-once retry that
  // TOKEN_TRANSFER's durability gate depends on (a failed event would
  // be persisted as "processed" and never re-tried across restarts).
  //
  // `inFlightEventIds` is the IN-MEMORY set used for concurrent-arrival
  // dedup: the same relay event may be delivered via multiple
  // subscriptions (wallet sub + chat sub) within the same process. It
  // is never persisted; entries are removed in the `finally` block of
  // `handleEvent` so the second arrival short-circuits while the first
  // is still in flight.
  private processedEventIds = new Set<string>();
  private inFlightEventIds = new Set<string>();

  /**
   * Issue #275 — debounce timer for persisting `processedEventIds` and
   * `failedEventCooldowns`. Coalesces a burst of EOSE-replay arrivals
   * into a single storage write. Set to `LIMITS.PROCESSED_EVENT_IDS_FLUSH_MS`.
   */
  private persistDedupTimer: ReturnType<typeof setTimeout> | null = null;
  /** Reentrancy guard so concurrent schedules don't race the in-flight write. */
  private persistDedupInFlight: Promise<void> | null = null;
  /** True once dedup state has been hydrated from storage; gates re-hydration. */
  private dedupHydrated = false;

  /**
   * Issue #272 + #275 — per-event failure cooldown ledger for TOKEN_TRANSFER
   * replays. When `handleIncomingTransfer` returns `false` (the at-
   * least-once gate refused the ack), we record an exponential cool-
   * down so the relay-paced replay storm cannot busy-spin the
   * receive pipeline (parse → crypto verify → flush → HEAD-verify)
   * for the same event on every reconnect cycle.
   *
   * Semantics:
   *   - `attempts` counts consecutive durability misses. Cleared on
   *     success (advance happens) or when the bounded budget exhausts.
   *   - `nextRetryAt` is `Date.now() + min(COOLDOWN_BASE_MS * 2^(n-1),
   *     COOLDOWN_MAX_MS)`. Events arriving inside the cooldown window
   *     are skipped without entering the gate.
   *   - After `MAX_REPLAY_ATTEMPTS` consecutive misses, we ADVANCE the
   *     cursor anyway and emit an operator alert. This matches the
   *     acceptance criterion in issue #272: "`[AT-LEAST-ONCE] not
   *     durable` count per token bounded by a small constant (≤3)
   *     rather than unbounded replay." Local-durability is intact
   *     (issue #272 also decoupled the per-flush HEAD-verify from
   *     the gate, so persistent durability=false now strictly
   *     indicates an underlying OrbitDB/pin POST/publish failure that
   *     replay alone won't fix — operator intervention is the right
   *     escalation).
   *   - The map is LRU-capped to bound memory under pathological
   *     replay floods. Eviction is single-victim per insert when at
   *     capacity (cheap; no full sort).
   *
   * Issue #275: this map is now PERSISTED across process restarts so
   * the bounded replay budget accumulates across CLI invocations
   * instead of resetting to zero per-process. Without persistence, a
   * persistently-failing TOKEN_TRANSFER could replay across CLI
   * sessions indefinitely because every fresh process saw `attempts=1`
   * and never reached the budget exhaustion threshold.
   */
  private failedEventCooldowns = new Map<
    string,
    { nextRetryAt: number; attempts: number }
  >();
  private static readonly DURABILITY_COOLDOWN_BASE_MS = 30_000;
  private static readonly DURABILITY_COOLDOWN_MAX_MS = 120_000;
  private static readonly DURABILITY_MAX_REPLAY_ATTEMPTS = 3;
  private static readonly DURABILITY_COOLDOWN_MAP_CAP = 256;
  private messageHandlers: Set<MessageHandler> = new Set();
  private transferHandlers: Set<TokenTransferHandler> = new Set();
  private paymentRequestHandlers: Set<PaymentRequestHandler> = new Set();
  private paymentRequestResponseHandlers: Set<PaymentRequestResponseHandler> = new Set();
  private readReceiptHandlers: Set<ReadReceiptHandler> = new Set();
  private typingIndicatorHandlers: Set<TypingIndicatorHandler> = new Set();
  private composingHandlers: Set<ComposingHandler> = new Set();
  private pendingMessages: IncomingMessage[] = [];
  /**
   * Issue #247 — buffer for TOKEN_TRANSFER events that arrive on this
   * outer provider before any handler is registered. The pre-Mux race
   * (#223 comment in `handleTokenTransfer`) sees relay events landing
   * here while `PaymentsModule` has registered its handler on the
   * AddressTransportAdapter, not on this provider. Without a buffer,
   * the events are dropped (allDurable=false → since-not-advanced) and
   * the only recovery is replay-on-reconnect — producing the persistent
   * "TOKEN_TRANSFER ... not durable" storm observed in
   * manual-test-full-recovery.sh.
   *
   * Buffered transfers are drained when a handler registers via
   * `onTokenTransfer` (in-session catch-up). If the process exits
   * before any handler registers, `lastEventTs` was not advanced and
   * the events replay on next reconnect — preserving at-least-once.
   *
   * Each entry retains the original event's `created_at` (seconds) so
   * the drain can advance `lastEventTs` per-event on successful
   * delivery.
   */
  private pendingTransfers: Array<{
    readonly transfer: IncomingTokenTransfer;
    readonly createdAtSec: number;
  }> = [];
  private broadcastHandlers: Map<string, Set<BroadcastHandler>> = new Map();
  private eventCallbacks: Set<TransportEventCallback> = new Set();

  constructor(config: NostrTransportProviderConfig) {
    this.config = {
      relays: config.relays ?? [...DEFAULT_NOSTR_RELAYS],
      timeout: config.timeout ?? TIMEOUTS.WEBSOCKET_CONNECT,
      autoReconnect: config.autoReconnect ?? true,
      reconnectDelay: config.reconnectDelay ?? TIMEOUTS.NOSTR_RECONNECT_DELAY,
      maxReconnectAttempts: config.maxReconnectAttempts ?? TIMEOUTS.MAX_RECONNECT_ATTEMPTS,
      debug: config.debug ?? false,
      createWebSocket: config.createWebSocket,
      generateUUID: config.generateUUID ?? defaultUUIDGenerator,
    };
    this.storage = config.storage ?? null;
  }

  /**
   * Get the WebSocket factory (used by MultiAddressTransportMux to share the same factory).
   */
  getWebSocketFactory(): WebSocketFactory {
    return this.config.createWebSocket;
  }

  /**
   * Get the configured relay URLs.
   */
  getConfiguredRelays(): string[] {
    return [...this.config.relays];
  }

  /**
   * Get the storage adapter.
   */
  getStorageAdapter(): TransportStorageAdapter | null {
    return this.storage;
  }

  /**
   * Get the underlying NostrClient (or null if not yet connected).
   *
   * Exposed so {@link MultiAddressTransportMux} can share the same
   * client/socket pair instead of opening a duplicate WebSocket per
   * relay (#123). The transport owns the client's lifecycle — callers
   * MUST NOT call {@code disconnect()} on the returned instance.
   */
  getNostrClient(): NostrClient | null {
    return this.nostrClient;
  }

  /**
   * Suppress event subscriptions — unsubscribe wallet/chat filters
   * but keep the connection alive for resolve/identity-binding operations.
   * Used when MultiAddressTransportMux takes over event handling.
   *
   * Stops application-level keepalive ping timers on the bare connection.
   * After suppression this NostrClient has zero active subscriptions; the
   * connection is retained only as an outbound resolve()/identity-binding
   * channel. Application pings on a subscription-free connection have been
   * empirically observed to elicit no relay response, causing
   * `appears stale` flapping every ~45 s. OS-level TCP keepalive maintains
   * connection liveness; we don't need application-level pings here.
   */
  suppressSubscriptions(): void {
    if (!this.nostrClient) return;

    if (this.walletSubscriptionId) {
      this.nostrClient.unsubscribe(this.walletSubscriptionId);
      this.walletSubscriptionId = null;
    }
    if (this.chatSubscriptionId) {
      this.nostrClient.unsubscribe(this.chatSubscriptionId);
      this.chatSubscriptionId = null;
    }
    if (this.mainSubscriptionId) {
      this.nostrClient.unsubscribe(this.mainSubscriptionId);
      this.mainSubscriptionId = null;
    }

    this.stopApplicationPingsOnBareClient();

    // Prevent re-subscription on reconnect by marking subscriptions as suppressed
    this._subscriptionsSuppressed = true;
    logger.debug('Nostr', 'Subscriptions suppressed — mux handles event routing');
  }

  /**
   * Stop the bare NostrClient's per-relay application-level keepalive
   * ping timers. Reaches into NostrClient internals via a structural cast
   * because `stopPingTimer(url)` and `relays` are declared `private` in
   * @unicitylabs/nostr-js-sdk. An upstream PR adding a public
   * `stopAllPingTimers()` would let us drop this cast.
   *
   * Called from `suppressSubscriptions()` and from the post-reconnect path
   * in `setIdentity` when suppression is active — every fresh NostrClient
   * starts its own ping timers on connect, so we must re-stop them after
   * each replacement.
   */
  private stopApplicationPingsOnBareClient(): void {
    if (!this.nostrClient) return;
    const internals = this.nostrClient as unknown as {
      relays: Map<string, unknown>;
      stopPingTimer(url: string): void;
    };
    for (const url of internals.relays.keys()) {
      internals.stopPingTimer(url);
    }
  }

  // Flag to prevent re-subscription after suppressSubscriptions()
  private _subscriptionsSuppressed = false;

  // ---------------------------------------------------------------------------
  // Issue #423 — handler-readiness gate
  //
  // Pre-#423: connect()/setIdentity() called subscribeToEvents() inline, opening
  // the relay subscription BEFORE any caller had registered handlers via
  // onTokenTransfer/onMessage/etc. When Sphere uses the MultiAddressTransportMux
  // path, handlers are registered on the MUX ADAPTER, not on this outer
  // provider — so the outer subscription would fire TOKEN_TRANSFER events at
  // an empty handler set, route them through the defensive `pendingTransfers`
  // buffer, and pin `lastEventTs` (issues #223 / #247). That produced the
  // "[AT-LEAST-ONCE] TOKEN_TRANSFER ... not durable" warn storm in soak logs.
  //
  // Fix: defer subscribeToEvents() until ARMED. Three ways to arm:
  //   1. Explicit `armSubscriptions()` call — Sphere uses this after wiring
  //      all modules (the bootstrap-time path).
  //   2. First `on*` handler registration — backward compatibility for
  //      consumers that register handlers directly on this provider (the
  //      non-mux path) without knowing about the gate.
  //   3. `suppressSubscriptions()` — mux is taking over; the gate becomes
  //      irrelevant because we won't subscribe anyway.
  //
  // `pendingArm` records that connect/setIdentity wanted to subscribe but the
  // gate was closed. When the gate opens (via #1 or #2), we drain the pending
  // arm. Reconnect-after-disconnect re-checks armed state so a relay reconnect
  // before arming does not bypass the gate. The state is "sticky": once armed,
  // re-arming is a no-op and subscriptions stay live for the rest of the
  // session.
  //
  // The `pendingTransfers` buffer (around line 2298) becomes effectively dead
  // code in the common Sphere paths now — events can no longer arrive before
  // a handler is wired. It is kept as defense-in-depth and STILL warns at the
  // `[AT-LEAST-ONCE] not durable` site, because if it ever fires post-#423,
  // something genuinely unexpected is happening (e.g., a backfill burst that
  // outraces the handler-attach sequence) and an operator should see it.
  // ---------------------------------------------------------------------------
  private subscriptionsArmed = false;
  private pendingArm = false;

  // ===========================================================================
  // BaseProvider Implementation
  // ===========================================================================

  async connect(): Promise<void> {
    if (this.status === 'connected') return;

    this.status = 'connecting';

    try {
      // Ensure keyManager exists for NostrClient
      if (!this.keyManager) {
        // Create a temporary key manager - will be replaced when setIdentity is called
        const tempKey = Buffer.alloc(32);
        crypto.getRandomValues(tempKey);
        this.keyManager = NostrKeyManager.fromPrivateKey(tempKey);
      }

      // Create NostrClient with robust connection handling:
      // - autoReconnect: automatic reconnection with exponential backoff
      // - pingIntervalMs: keepalive pings to detect stale connections
      // - NIP-42 AUTH handling built-in
      this.nostrClient = new NostrClient(this.keyManager, {
        autoReconnect: this.config.autoReconnect,
        reconnectIntervalMs: this.config.reconnectDelay,
        maxReconnectIntervalMs: this.config.reconnectDelay * 16, // exponential backoff cap
        // 60 s keepalive — the SDK's no-filter `['REQ','ping',{limit:1}]`
        // trick false-positives at 15 s on real testnet under uneven relay
        // timing. After Mux takeover suppressSubscriptions stops these
        // timers entirely (see `stopApplicationPingsOnBareClient`); 60 s
        // covers the brief pre-suppress window AND any reconnect that
        // re-establishes the timer before suppression re-runs.
        pingIntervalMs: 60000,
        // Bump query timeout from the SDK default of 5s to 20s.
        // Real-world testnet observation (2026-05-01): under transient
        // relay overload, kind:30078 (nametag binding) queries take 5-7s
        // to return EVENT messages, even though the binding is on the
        // relay. The default 5s timeout fires before the event arrives,
        // resolveNametag returns null, and downstream sendDM throws
        // INVALID_RECIPIENT — causing every np.propose_deal to fail. 20s
        // gives the slow path enough headroom to complete while still
        // bailing reasonably fast on a truly broken relay.
        queryTimeoutMs: 20000,
      });

      // Add connection event listener for logging
      this.nostrClient.addConnectionListener({
        onConnect: (url) => {
          logger.debug('Nostr', 'NostrClient connected to relay:', url);
          this.emitEvent({ type: 'transport:connected', timestamp: Date.now() });
        },
        onDisconnect: (url, reason) => {
          logger.debug('Nostr', 'NostrClient disconnected from relay:', url, 'reason:', reason);
        },
        onReconnecting: (url, attempt) => {
          logger.debug('Nostr', 'NostrClient reconnecting to relay:', url, 'attempt:', attempt);
          this.emitEvent({ type: 'transport:reconnecting', timestamp: Date.now() });
        },
        onReconnected: (url) => {
          logger.debug('Nostr', 'NostrClient reconnected to relay:', url);
          this.emitEvent({ type: 'transport:connected', timestamp: Date.now() });
          // Re-establish subscriptions — the relay drops them on disconnect.
          // Issue #423: gated on the readiness arm. If the original session
          // was never armed (e.g., mux took over before any direct handler
          // registered), the re-subscribe path is a no-op until something
          // arms us. Once armed, reconnects re-subscribe automatically.
          this.maybeSubscribe().catch((err) => {
            logger.error('Nostr', 'Failed to re-subscribe after reconnect:', err);
          });
          // The reconnected socket starts a fresh ping timer; under
          // suppression we don't want it (see suppressSubscriptions()).
          if (this._subscriptionsSuppressed) {
            this.stopApplicationPingsOnBareClient();
          }
        },
      });

      // Connect to all relays (with timeout to prevent indefinite hang)
      await Promise.race([
        this.nostrClient.connect(...this.config.relays),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(
            `Transport connection timed out after ${this.config.timeout}ms`
          )), this.config.timeout)
        ),
      ]);

      // Need at least one successful connection
      if (!this.nostrClient.isConnected()) {
        throw new SphereError('Failed to connect to any relay', 'TRANSPORT_ERROR');
      }

      this.status = 'connected';
      this.emitEvent({ type: 'transport:connected', timestamp: Date.now() });
      logger.debug('Nostr', 'Connected to', this.nostrClient.getConnectedRelays().size, 'relays');

      // Set up subscriptions — gated on the handler-readiness arm (#423).
      // When the gate is closed, record `pendingArm` so `armSubscriptions()`
      // can drain it once handlers are wired. Without the gate, a relay event
      // could land before any consumer registered a handler (the pre-Mux race
      // in the Sphere bootstrap), and the outer transport would route through
      // the `pendingTransfers` defensive buffer, emit the "not durable" warn,
      // and pin `lastEventTs`.
      if (this.identity) {
        await this.maybeSubscribe();
      }
    } catch (error) {
      this.status = 'error';
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // Issue #275 — flush any pending dedup writes before tearing down
    // the connection. Without this, a process exit that catches the
    // tail of a 200ms debounce window would lose the latest
    // `processedEventIds` adds and force the next process to re-walk
    // the same relay backlog. The flush is best-effort; we swallow
    // errors so disconnect remains robust.
    if (this.persistDedupTimer) {
      clearTimeout(this.persistDedupTimer);
      this.persistDedupTimer = null;
    }
    if (this.storage && this.keyManager) {
      try {
        await this.persistDedupNow();
      } catch (err) {
        logger.debug('Nostr', 'disconnect: flush of persisted dedup failed:', err);
      }
    }

    if (this.nostrClient) {
      this.nostrClient.disconnect();
      this.nostrClient = null;
    }
    this.mainSubscriptionId = null;
    this.walletSubscriptionId = null;
    this.chatSubscriptionId = null;
    this.chatEoseFired = false;
    this.status = 'disconnected';
    this.emitEvent({ type: 'transport:disconnected', timestamp: Date.now() });
    logger.debug('Nostr', 'Disconnected from all relays');
  }

  isConnected(): boolean {
    return this.status === 'connected' && this.nostrClient?.isConnected() === true;
  }

  getStatus(): ProviderStatus {
    return this.status;
  }

  // ===========================================================================
  // Dynamic Relay Management
  // ===========================================================================

  /**
   * Get list of configured relay URLs
   */
  getRelays(): string[] {
    return [...this.config.relays];
  }

  /**
   * Get list of currently connected relay URLs
   */
  getConnectedRelays(): string[] {
    if (!this.nostrClient) return [];
    return Array.from(this.nostrClient.getConnectedRelays());
  }

  /**
   * Add a new relay dynamically
   * Will connect immediately if provider is already connected
   */
  async addRelay(relayUrl: string): Promise<boolean> {
    // Check if already configured
    if (this.config.relays.includes(relayUrl)) {
      logger.debug('Nostr', 'Relay already configured:', relayUrl);
      return false;
    }

    // Add to config
    this.config.relays.push(relayUrl);

    // Connect if provider is connected
    if (this.status === 'connected' && this.nostrClient) {
      try {
        await this.nostrClient.connect(relayUrl);
        logger.debug('Nostr', 'Added and connected to relay:', relayUrl);
        this.emitEvent({
          type: 'transport:relay_added',
          timestamp: Date.now(),
          data: { relay: relayUrl, connected: true },
        });
        return true;
      } catch (error) {
        logger.debug('Nostr', 'Failed to connect to new relay:', relayUrl, error);
        this.emitEvent({
          type: 'transport:relay_added',
          timestamp: Date.now(),
          data: { relay: relayUrl, connected: false, error: String(error) },
        });
        return false;
      }
    }

    this.emitEvent({
      type: 'transport:relay_added',
      timestamp: Date.now(),
      data: { relay: relayUrl, connected: false },
    });
    return true;
  }

  /**
   * Remove a relay dynamically
   * Will disconnect from the relay if connected
   * NOTE: NostrClient doesn't support removing individual relays at runtime.
   * We remove from config so it won't be used on next connect().
   */
  async removeRelay(relayUrl: string): Promise<boolean> {
    const index = this.config.relays.indexOf(relayUrl);
    if (index === -1) {
      logger.debug('Nostr', 'Relay not found:', relayUrl);
      return false;
    }

    // Remove from config
    this.config.relays.splice(index, 1);
    logger.debug('Nostr', 'Removed relay from config:', relayUrl);

    this.emitEvent({
      type: 'transport:relay_removed',
      timestamp: Date.now(),
      data: { relay: relayUrl },
    });

    // Check if we still have connections
    if (this.nostrClient && !this.nostrClient.isConnected() && this.status === 'connected') {
      this.status = 'error';
      this.emitEvent({
        type: 'transport:error',
        timestamp: Date.now(),
        data: { error: 'No connected relays remaining' },
      });
    }

    return true;
  }

  /**
   * Check if a relay is configured
   */
  hasRelay(relayUrl: string): boolean {
    return this.config.relays.includes(relayUrl);
  }

  /**
   * Check if a relay is currently connected
   */
  isRelayConnected(relayUrl: string): boolean {
    if (!this.nostrClient) return false;
    return this.nostrClient.getConnectedRelays().has(relayUrl);
  }

  // ===========================================================================
  // TransportProvider Implementation
  // ===========================================================================

  async setIdentity(identity: FullIdentity): Promise<void> {
    this.identity = identity;

    // Clear per-address state so stale dedup entries from previous address
    // don't block legitimate events for the new address.
    this.processedEventIds.clear();
    this.inFlightEventIds.clear();
    this.failedEventCooldowns.clear();
    this.dedupHydrated = false;
    this.lastEventTs = 0;
    this.lastDmEventTs = 0;
    this.fallbackDmSince = null;
    // Cancel any pending debounced persist — the previous identity's
    // state must not leak into the new identity's storage namespace.
    if (this.persistDedupTimer) {
      clearTimeout(this.persistDedupTimer);
      this.persistDedupTimer = null;
    }

    // Create NostrKeyManager from private key.
    // Steelman³³ warning: strict hex decode — Buffer.from(_, 'hex')
    // silently truncates malformed inputs.
    const secretKey = strictHexToBytes(identity.privateKey);
    this.keyManager = NostrKeyManager.fromPrivateKey(secretKey);

    // Use Nostr-format pubkey (32 bytes / 64 hex chars) from keyManager
    const nostrPubkey = this.keyManager.getPublicKeyHex();
    logger.debug('Nostr', 'Identity set, Nostr pubkey:', nostrPubkey.slice(0, 16) + '...');

    // If we already have a NostrClient with a temp key, we need to reconnect with the real key
    // NostrClient doesn't support changing key at runtime
    if (this.nostrClient && this.status === 'connected') {
      logger.debug('Nostr', 'Identity changed while connected - recreating NostrClient');
      const oldClient = this.nostrClient;

      // Create new client with real identity
      this.nostrClient = new NostrClient(this.keyManager, {
        autoReconnect: this.config.autoReconnect,
        reconnectIntervalMs: this.config.reconnectDelay,
        maxReconnectIntervalMs: this.config.reconnectDelay * 16,
        pingIntervalMs: 15000, // 15 second keepalive pings
        queryTimeoutMs: 20000, // see same option above for rationale
      });

      // Add connection event listener
      this.nostrClient.addConnectionListener({
        onConnect: (url) => {
          logger.debug('Nostr', 'NostrClient connected to relay:', url);
        },
        onDisconnect: (url, reason) => {
          logger.debug('Nostr', 'NostrClient disconnected from relay:', url, 'reason:', reason);
        },
        onReconnecting: (url, attempt) => {
          logger.debug('Nostr', 'NostrClient reconnecting to relay:', url, 'attempt:', attempt);
        },
        onReconnected: (url) => {
          logger.debug('Nostr', 'NostrClient reconnected to relay:', url);
          // Mirror the primary listener: under suppression, the
          // reconnected socket's fresh ping timer is unwanted.
          if (this._subscriptionsSuppressed) {
            this.stopApplicationPingsOnBareClient();
          }
        },
      });

      // Connect with new identity, set up subscriptions, then disconnect old client
      await Promise.race([
        this.nostrClient.connect(...this.config.relays),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(
            `Transport reconnection timed out after ${this.config.timeout}ms`
          )), this.config.timeout)
        ),
      ]);
      // Issue #423 — gate on handler-readiness arm. The previous identity may
      // have armed subscriptions already, in which case `maybeSubscribe()`
      // proceeds. Otherwise it records `pendingArm` so the next arming call
      // (`armSubscriptions()` or first handler registration) opens the
      // subscription against the new identity.
      await this.maybeSubscribe();
      // The fresh NostrClient started its own ping timers on connect.
      // If subscriptions were suppressed (mux owns event routing), the
      // bare client should not ping — see suppressSubscriptions() docstring.
      if (this._subscriptionsSuppressed) {
        this.stopApplicationPingsOnBareClient();
      }
      oldClient.disconnect();
    } else if (this.isConnected()) {
      // Already connected with right key, just subscribe (gated; #423).
      await this.maybeSubscribe();
    }
  }

  setFallbackSince(sinceSeconds: number): void {
    this.fallbackSince = sinceSeconds;
  }

  setFallbackDmSince(sinceSeconds: number): void {
    this.fallbackDmSince = sinceSeconds;
  }

  /**
   * Get the Nostr-format public key (32 bytes / 64 hex chars)
   * This is the x-coordinate only, without the 02/03 prefix.
   */
  getNostrPubkey(): string {
    if (!this.keyManager) {
      throw new SphereError('KeyManager not initialized - call setIdentity first', 'NOT_INITIALIZED');
    }
    return this.keyManager.getPublicKeyHex();
  }

  async sendMessage(
    recipientPubkey: string,
    content: string,
    options?: SendMessageOptions,
  ): Promise<string> {
    this.ensureReady();

    // NIP-17 requires 32-byte x-only pubkey; strip 02/03 prefix if present
    const nostrRecipient = recipientPubkey.length === 66 && (recipientPubkey.startsWith('02') || recipientPubkey.startsWith('03'))
      ? recipientPubkey.slice(2)
      : recipientPubkey;

    // Wrap content with sender nametag for Sphere app compatibility
    const senderNametag = this.identity?.nametag;
    const wrappedContent = senderNametag
      ? JSON.stringify({ senderNametag, text: content })
      : content;

    // Create NIP-17 gift-wrapped message (kind 1059) for recipient
    const giftWrap = NIP17.createGiftWrap(this.keyManager!, nostrRecipient, wrappedContent);

    await this.publishWithVerification(giftWrap, 3, 'dm');

    // NIP-17 self-wrap: send a copy to ourselves so relay can replay sent messages.
    // Content includes recipientPubkey and originalId for dedup against the live-sent record.
    //
    // Skipped when `options.selfWrap === false` — short-lived senders (CLI RPC,
    // sphere-sdk#555) exit before they could ever read their own self-wrap, so
    // the publish is pure relay-index pollution for them.
    if (options?.selfWrap !== false) {
      const selfWrapContent = JSON.stringify({
        selfWrap: true,
        originalId: giftWrap.id,
        recipientPubkey,
        senderNametag,
        text: content,
      });
      const selfPubkey = this.keyManager!.getPublicKeyHex();
      const selfGiftWrap = NIP17.createGiftWrap(this.keyManager!, selfPubkey, selfWrapContent);
      this.publishEvent(selfGiftWrap).catch(err => {
        logger.debug('Nostr', 'Self-wrap publish failed:', err);
      });
    }

    this.emitEvent({
      type: 'message:sent',
      timestamp: Date.now(),
      data: { recipient: recipientPubkey },
    });

    return giftWrap.id;
  }

  onMessage(handler: MessageHandler): () => void {
    this.messageHandlers.add(handler);
    // Issue #423 — auto-arm the readiness gate so the relay subscription
    // opens once a handler exists (backward compat for consumers that
    // don't call `armSubscriptions()` explicitly).
    this.autoArmOnHandlerRegistration();

    // Flush any messages that arrived before this handler was registered
    if (this.pendingMessages.length > 0) {
      const pending = this.pendingMessages;
      this.pendingMessages = [];
      logger.debug('Nostr', 'Flushing', pending.length, 'buffered messages to new handler');
      for (const message of pending) {
        try {
          handler(message);
        } catch (error) {
          logger.debug('Nostr', 'Message handler error (buffered):', error);
        }
      }
    }

    return () => this.messageHandlers.delete(handler);
  }

  async sendTokenTransfer(
    recipientPubkey: string,
    payload: TokenTransferPayload
  ): Promise<string> {
    this.ensureReady();

    // T.2.E — shape-agnostic outbound serialization.
    //
    // Two valid serialization paths exist for the `TokenTransferPayload`
    // tagged union (`types/uxf-transfer`):
    //
    //   1. UXF v1.0 envelopes (`kind === 'uxf-car' | 'uxf-cid'`) and the
    //      four legacy shapes recognized by `isLegacyTokenTransferPayload`:
    //      use the canonical, byte-deterministic encoder from T.1.D so that
    //      every legitimate envelope on the wire is identical across
    //      sender runs (important for content-addressed audit and replay
    //      detection — §5.6).
    //   2. Anything else (custom test payloads, callers that bypass the
    //      `as unknown as TokenTransferPayload` cast already used by
    //      `PaymentsModule` for partially-built shapes): fall through to
    //      `JSON.stringify`. This preserves backward compatibility with
    //      the pre-T.2.E behavior — no caller currently exercises this
    //      path, but the safety valve is critical to avoid breaking the
    //      legacy chain split during the migration wave.
    //
    // Content must have "token_transfer:" prefix for nostr-js-sdk
    // compatibility — preserved verbatim from the pre-T.2.E implementation
    // and matched by `stripContentPrefix()` on the receive side.
    const serialized = isUxfTransferPayload(payload)
      ? encodeTransferPayload(payload)
      : JSON.stringify(payload);
    const content = 'token_transfer:' + serialized;

    // IMPORTANT: kind 31113 is a Parameterized Replaceable Event (NIP-01).
    // The relay keeps only the LATEST event per (pubkey, kind, d-tag).
    // A static d-tag like 'token-transfer' caused subsequent sends to OVERWRITE
    // previous ones on the relay — the recipient only saw the last token sent.
    // Fix: use a unique d-tag per event so each transfer is its own slot.
    const uniqueD = `token-transfer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const event = await this.createEncryptedEvent(
      EVENT_KINDS.TOKEN_TRANSFER,
      content,
      [
        ['p', recipientPubkey],
        ['d', uniqueD],
        ['type', 'token_transfer'],
      ]
    );

    await this.publishWithVerification(event, 3, 'token_transfer');

    this.emitEvent({
      type: 'transfer:sent',
      timestamp: Date.now(),
      data: { recipient: recipientPubkey },
    });

    return event.id;
  }

  onTokenTransfer(handler: TokenTransferHandler): () => void {
    this.transferHandlers.add(handler);
    // Issue #423 — auto-arm the readiness gate. Subscription opens here
    // for direct-on-outer-provider consumers; for the mux path the gate
    // is suppressed and no subscription opens on the outer provider.
    this.autoArmOnHandlerRegistration();

    // Issue #247 — drain any TOKEN_TRANSFER events that arrived BEFORE
    // this handler was registered. With #423 in place the gate prevents
    // subscriptions from opening before handlers attach, so this drain
    // should be effectively dead code in the Sphere bootstrap path. It
    // is retained as defense-in-depth (no-op when the buffer is empty)
    // for any pathological case the gate cannot cover.
    //
    // Buffer is snapshotted and cleared atomically before the (async)
    // handler calls — events arriving during the drain take the live
    // path (`transferHandlers.size > 0` is true now) and won't
    // double-buffer.
    //
    // Per-event durability propagation: if the handler returns truthy
    // (or undefined), advance `lastEventTs` so the event doesn't
    // re-replay on next reconnect. If the handler returns `false` or
    // throws, leave `lastEventTs` alone — the event replays normally.
    //
    // Fire-and-forget the drain so onTokenTransfer remains synchronous
    // (its existing contract). Errors are logged at debug; the drain
    // is best-effort and re-replay covers any losses.
    if (this.pendingTransfers.length > 0) {
      const pending = this.pendingTransfers;
      this.pendingTransfers = [];
      logger.debug(
        'Nostr',
        `Flushing ${pending.length} buffered TOKEN_TRANSFER event(s) to new handler`,
      );
      void (async () => {
        for (const { transfer, createdAtSec } of pending) {
          try {
            const result = await handler(transfer);
            // `undefined` is the legacy "no opinion" contract → durable.
            if (result !== false) {
              this.updateLastEventTimestamp(createdAtSec);
              // Issue #275 — mark the buffered event as processed so
              // cross-process replays short-circuit. Without this, the
              // pre-Mux buffered events (which never enter handleEvent's
              // success branches) would not be persisted in the dedup
              // set, and every fresh CLI invocation would re-walk them.
              this.markEventProcessed(transfer.id);
            } else {
              logger.debug(
                'Nostr',
                `Buffered TOKEN_TRANSFER drain handler returned false — leaving since at ${this.lastEventTs}`,
              );
            }
          } catch (error) {
            logger.debug('Nostr', 'Buffered transfer handler error:', error);
          }
        }
      })();
    }

    return () => this.transferHandlers.delete(handler);
  }

  async sendPaymentRequest(
    recipientPubkey: string,
    payload: PaymentRequestPayload
  ): Promise<string> {
    this.ensureReady();

    const requestId = this.config.generateUUID();
    const amount = typeof payload.amount === 'bigint' ? payload.amount.toString() : payload.amount;

    // Build request content matching nostr-js-sdk format
    const requestContent = {
      requestId,
      amount,
      coinId: payload.coinId,
      message: payload.message,
      recipientNametag: payload.recipientNametag,
      deadline: Date.now() + 5 * 60 * 1000, // 5 minutes default
    };

    // Content must have "payment_request:" prefix for nostr-js-sdk compatibility
    const content = 'payment_request:' + JSON.stringify(requestContent);

    // Build tags matching nostr-js-sdk format
    const tags: string[][] = [
      ['p', recipientPubkey],
      ['type', 'payment_request'],
      ['amount', amount],
    ];
    if (payload.recipientNametag) {
      tags.push(['recipient', payload.recipientNametag]);
    }

    const event = await this.createEncryptedEvent(
      EVENT_KINDS.PAYMENT_REQUEST,
      content,
      tags
    );

    await this.publishEvent(event);

    logger.debug('Nostr', 'Sent payment request:', event.id);

    return event.id;
  }

  onPaymentRequest(handler: PaymentRequestHandler): () => void {
    this.paymentRequestHandlers.add(handler);
    this.autoArmOnHandlerRegistration(); // Issue #423
    return () => this.paymentRequestHandlers.delete(handler);
  }

  async sendPaymentRequestResponse(
    recipientPubkey: string,
    payload: PaymentRequestResponsePayload
  ): Promise<string> {
    this.ensureReady();

    // Build response content
    const responseContent = {
      requestId: payload.requestId,
      responseType: payload.responseType,
      message: payload.message,
      transferId: payload.transferId,
    };

    // Create encrypted payment request response event
    // Content must have "payment_response:" prefix for nostr-js-sdk compatibility
    const content = 'payment_response:' + JSON.stringify(responseContent);
    const event = await this.createEncryptedEvent(
      EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
      content,
      [
        ['p', recipientPubkey],
        ['e', payload.requestId], // Reference to original request
        ['d', 'payment-request-response'],
        ['type', 'payment_response'],
      ]
    );

    await this.publishEvent(event);

    logger.debug('Nostr', 'Sent payment request response:', event.id, 'type:', payload.responseType);

    return event.id;
  }

  onPaymentRequestResponse(handler: PaymentRequestResponseHandler): () => void {
    this.paymentRequestResponseHandlers.add(handler);
    this.autoArmOnHandlerRegistration(); // Issue #423
    return () => this.paymentRequestResponseHandlers.delete(handler);
  }

  // ===========================================================================
  // Read Receipts
  // ===========================================================================

  async sendReadReceipt(recipientTransportPubkey: string, messageEventId: string): Promise<void> {
    if (!this.keyManager) throw new SphereError('Not initialized', 'NOT_INITIALIZED');

    // NIP-17 uses x-only pubkeys (64 hex chars, no 02/03 prefix)
    const nostrRecipient = recipientTransportPubkey.length === 66
      ? recipientTransportPubkey.slice(2)
      : recipientTransportPubkey;

    const event = NIP17.createReadReceipt(this.keyManager, nostrRecipient, messageEventId);
    await this.publishEvent(event);
    logger.debug('Nostr', 'Sent read receipt for:', messageEventId, 'to:', nostrRecipient.slice(0, 16));
  }

  onReadReceipt(handler: ReadReceiptHandler): () => void {
    this.readReceiptHandlers.add(handler);
    this.autoArmOnHandlerRegistration(); // Issue #423
    return () => this.readReceiptHandlers.delete(handler);
  }

  // ===========================================================================
  // Typing Indicators
  // ===========================================================================

  async sendTypingIndicator(recipientTransportPubkey: string): Promise<void> {
    if (!this.keyManager) throw new SphereError('Not initialized', 'NOT_INITIALIZED');

    const nostrRecipient = recipientTransportPubkey.length === 66
      ? recipientTransportPubkey.slice(2)
      : recipientTransportPubkey;

    const content = JSON.stringify({
      type: 'typing',
      senderNametag: this.identity?.nametag,
    });
    const event = NIP17.createGiftWrap(this.keyManager, nostrRecipient, content);
    await this.publishEvent(event);
  }

  onTypingIndicator(handler: TypingIndicatorHandler): () => void {
    this.typingIndicatorHandlers.add(handler);
    this.autoArmOnHandlerRegistration(); // Issue #423
    return () => this.typingIndicatorHandlers.delete(handler);
  }

  onChatReady(handler: () => void): () => void {
    // If EOSE already fired, invoke immediately
    if (this.chatEoseFired) {
      try { handler(); } catch { /* ignore */ }
      return () => {};
    }
    this.chatEoseHandlers.push(handler);
    return () => {
      this.chatEoseHandlers = this.chatEoseHandlers.filter(h => h !== handler);
    };
  }

  // ===========================================================================
  // Composing Indicators (NIP-59 kind 25050)
  // ===========================================================================

  onComposing(handler: ComposingHandler): () => void {
    this.composingHandlers.add(handler);
    this.autoArmOnHandlerRegistration(); // Issue #423
    return () => this.composingHandlers.delete(handler);
  }

  async sendComposingIndicator(recipientPubkey: string, content: string): Promise<void> {
    this.ensureReady();

    // NIP-17 requires 32-byte x-only pubkey; strip 02/03 prefix if present
    const nostrRecipient = recipientPubkey.length === 66 && (recipientPubkey.startsWith('02') || recipientPubkey.startsWith('03'))
      ? recipientPubkey.slice(2)
      : recipientPubkey;

    // Build NIP-17 gift wrap with kind 25050 rumor (instead of kind 14 for DMs).
    // We replicate the three-layer NIP-59 envelope because NIP17.createGiftWrap
    // hardcodes kind 14 for the inner rumor.
    const giftWrap = this.createCustomKindGiftWrap(nostrRecipient, content, COMPOSING_INDICATOR_KIND);
    await this.publishEvent(giftWrap);
  }

  /**
   * Resolve any identifier to full peer information.
   * Routes to the appropriate specific resolve method based on identifier format.
   */
  async resolve(identifier: string): Promise<PeerInfo | null> {
    // @nametag
    if (identifier.startsWith('@')) {
      return this.resolveNametagInfo(identifier.slice(1));
    }

    // DIRECT:// or PROXY:// address
    if (identifier.startsWith('DIRECT:') || identifier.startsWith('PROXY:')) {
      return this.resolveAddressInfo(identifier);
    }

    // L1 address (alpha1... or alphat1...)
    if (identifier.startsWith('alpha1') || identifier.startsWith('alphat1')) {
      return this.resolveAddressInfo(identifier);
    }

    // 66-char hex starting with 02/03 → compressed chain pubkey (33 bytes)
    if (/^0[23][0-9a-f]{64}$/i.test(identifier)) {
      return this.resolveAddressInfo(identifier);
    }

    // 64-char hex string → transport pubkey
    if (/^[0-9a-f]{64}$/i.test(identifier)) {
      return this.resolveTransportPubkeyInfo(identifier);
    }

    // Fallback: treat as bare nametag
    return this.resolveNametagInfo(identifier);
  }

  async resolveNametag(nametag: string): Promise<string | null> {
    await this.ensureConnectedForResolve();
    // Delegate to nostr-js-sdk which implements first-seen-wins anti-hijacking
    return this.nostrClient!.queryPubkeyByNametag(nametag);
  }

  async resolveNametagInfo(nametag: string): Promise<PeerInfo | null> {
    await this.ensureConnectedForResolve();

    // Delegate to nostr-js-sdk which implements first-seen-wins anti-hijacking
    const binding = await this.nostrClient!.queryBindingByNametag(nametag);
    if (!binding) {
      logger.debug('Nostr', `resolveNametagInfo: no binding events found for Unicity ID "${nametag}"`);
      return null;
    }

    return this.bindingInfoToPeerInfo(binding, nametag);
  }

  /**
   * Resolve a DIRECT://, PROXY://, or L1 address to full peer info.
   * Performs reverse lookup via nostr-js-sdk with first-seen-wins anti-hijacking.
   */
  async resolveAddressInfo(address: string): Promise<PeerInfo | null> {
    await this.ensureConnectedForResolve();

    const binding = await this.nostrClient!.queryBindingByAddress(address);
    if (!binding) return null;

    return this.bindingInfoToPeerInfo(binding);
  }

  /**
   * Convert a BindingInfo (from nostr-js-sdk) to PeerInfo (sphere-sdk type).
   * Computes PROXY address from nametag if available.
   *
   * T.8.B — When a nametag is resolved we additionally do a best-effort
   * query for the peer's capability-bearing identity binding event (lives
   * on a different d-tag than the nametag binding). Capability hints are
   * informational only and the lookup never throws on failure.
   */
  private async bindingInfoToPeerInfo(binding: BindingInfo, nametag?: string): Promise<PeerInfo> {
    const nametagValue = nametag || binding.nametag;
    let proxyAddress: string | undefined = binding.proxyAddress;

    // v2: PROXY:// address scheme removed — DIRECT-only. Skip synthesis;
    // downstream consumers must fall back to `directAddress` for delivery.
    // (Legacy `binding.proxyAddress` is still surfaced verbatim above so
    // pre-v2 relay records remain readable.)

    // T.8.B — Best-effort capability hint enrichment. Upstream BindingInfo
    // is lossy w.r.t. wireProtocols / assetKinds; query the predictable
    // per-pubkey identity binding event to recover them. Failure is silent.
    const capabilities = await this.fetchCapabilityHints(binding.transportPubkey);

    return {
      nametag: nametagValue,
      transportPubkey: binding.transportPubkey,
      chainPubkey: binding.publicKey || '',
      l1Address: binding.l1Address || '',
      directAddress: binding.directAddress || '',
      proxyAddress,
      timestamp: binding.timestamp,
      ...capabilities,
    };
  }

  /**
   * T.8.B — Extract capability hints (`wireProtocols`, `assetKinds`) from
   * a binding event's raw JSON content.
   *
   * Returns an object whose keys are present ONLY when the corresponding
   * field appeared in the parsed content. This preserves the W20 absent vs
   * empty distinction at the type level: a missing key on the returned
   * object means "field absent on the wire" (for `assetKinds` callers
   * default to `['coin']` per W20); an EMPTY array means "field present
   * but empty" (informational quirk, no W20 default).
   */
  private extractCapabilityHints(rawContent: unknown): {
    wireProtocols?: ReadonlyArray<string>;
    assetKinds?: ReadonlyArray<string>;
  } {
    if (!rawContent || typeof rawContent !== 'object') return {};
    const content = rawContent as Record<string, unknown>;
    const out: {
      wireProtocols?: ReadonlyArray<string>;
      assetKinds?: ReadonlyArray<string>;
    } = {};
    const wp = content.wire_protocols;
    if (Array.isArray(wp)) {
      out.wireProtocols = wp.filter((v): v is string => typeof v === 'string');
    }
    const ak = content.asset_kinds;
    if (Array.isArray(ak)) {
      out.assetKinds = ak.filter((v): v is string => typeof v === 'string');
    }
    return out;
  }

  /**
   * T.8.B — Best-effort fetch of capability hints for a peer.
   *
   * Queries the predictable per-pubkey identity binding event (the one
   * `publishIdentityBindingWithCapabilities` writes) and returns the hints
   * extracted from its content. Returns an empty object on any failure
   * (relay error, no event, parse error). Capability hints are
   * informational and MUST NOT block resolution.
   */
  private async fetchCapabilityHints(transportPubkey: string): Promise<{
    wireProtocols?: ReadonlyArray<string>;
    assetKinds?: ReadonlyArray<string>;
  }> {
    try {
      const events = await this.queryEvents({
        kinds: [EVENT_KINDS.NAMETAG_BINDING],
        authors: [transportPubkey],
        limit: 5,
      });
      if (events.length === 0) return {};
      // Newest-first; pick the first event whose content carries either
      // capability field. Older entries authored by the same pubkey may
      // pre-date T.8.B and lack the fields entirely.
      const sorted = [...events].sort((a, b) => b.created_at - a.created_at);
      for (const event of sorted) {
        try {
          const content = JSON.parse(event.content) as Record<string, unknown>;
          const hints = this.extractCapabilityHints(content);
          if (hints.wireProtocols !== undefined || hints.assetKinds !== undefined) {
            return hints;
          }
        } catch {
          // Skip unparseable events.
        }
      }
      return {};
    } catch {
      return {};
    }
  }

  /**
   * Resolve transport pubkey (Nostr pubkey) to full peer info.
   * Queries binding events authored by the given pubkey.
   */
  async resolveTransportPubkeyInfo(transportPubkey: string): Promise<PeerInfo | null> {
    await this.ensureConnectedForResolve();

    const events = await this.queryEvents({
      kinds: [EVENT_KINDS.NAMETAG_BINDING],
      authors: [transportPubkey],
      limit: 5,
    });

    if (events.length === 0) return null;

    // Sort by timestamp descending and take the most recent
    events.sort((a, b) => b.created_at - a.created_at);
    const bindingEvent = events[0];

    try {
      const content = JSON.parse(bindingEvent.content);
      // T.8.B — Capability hints from the same content blob (when present).
      const capabilities = this.extractCapabilityHints(content);

      return {
        nametag: content.nametag || undefined,
        transportPubkey: bindingEvent.pubkey,
        chainPubkey: content.public_key || '',
        l1Address: content.l1_address || '',
        directAddress: content.direct_address || '',
        proxyAddress: content.proxy_address || undefined,
        timestamp: bindingEvent.created_at * 1000,
        ...capabilities,
      };
    } catch {
      return {
        transportPubkey: bindingEvent.pubkey,
        chainPubkey: '',
        l1Address: '',
        directAddress: '',
        timestamp: bindingEvent.created_at * 1000,
      };
    }
  }

  /**
   * Batch-resolve multiple transport pubkeys to peer info.
   * Used for HD address discovery — single relay query with multi-author filter.
   */
  async discoverAddresses(transportPubkeys: string[]): Promise<PeerInfo[]> {
    await this.ensureConnectedForResolve();

    if (transportPubkeys.length === 0) return [];

    const events = await this.queryEvents({
      kinds: [EVENT_KINDS.NAMETAG_BINDING],
      authors: transportPubkeys,
      limit: transportPubkeys.length * 2,
    });

    if (events.length === 0) return [];

    // Group by author, take most recent per author
    const byAuthor = new Map<string, NostrEvent>();
    for (const event of events) {
      const existing = byAuthor.get(event.pubkey);
      if (!existing || event.created_at > existing.created_at) {
        byAuthor.set(event.pubkey, event);
      }
    }

    const results: PeerInfo[] = [];
    for (const [pubkey, event] of byAuthor) {
      try {
        const content = JSON.parse(event.content);
        // T.8.B — Capability hints from the same event content (when present).
        const capabilities = this.extractCapabilityHints(content);
        results.push({
          nametag: content.nametag || undefined,
          transportPubkey: pubkey,
          chainPubkey: content.public_key || '',
          l1Address: content.l1_address || '',
          directAddress: content.direct_address || '',
          proxyAddress: content.proxy_address || undefined,
          timestamp: event.created_at * 1000,
          ...capabilities,
        });
      } catch {
        // Skip unparseable events
      }
    }

    return results;
  }

  /**
   * Recover nametag for the current identity by searching for encrypted nametag events
   * Used after wallet import to recover associated nametag
   * @returns Decrypted nametag or null if none found
   */
  async recoverNametag(): Promise<string | null> {
    await this.ensureConnectedForResolve();
    if (!this.identity) {
      throw new SphereError('Identity not set', 'NOT_INITIALIZED');
    }

    if (!this.identity || !this.keyManager) {
      throw new SphereError('Identity not set', 'NOT_INITIALIZED');
    }

    const nostrPubkey = this.getNostrPubkey();
    logger.debug('Nostr', 'Searching for nametag events for pubkey:', nostrPubkey.slice(0, 16) + '...');

    // Query for nametag binding events authored by this pubkey
    const events = await this.queryEvents({
      kinds: [EVENT_KINDS.NAMETAG_BINDING],
      authors: [nostrPubkey],
      limit: 10, // Get recent events in case of updates
    });

    if (events.length === 0) {
      logger.debug('Nostr', 'No nametag events found for this pubkey');
      return null;
    }

    // Sort by timestamp descending to get most recent
    events.sort((a, b) => b.created_at - a.created_at);

    // Try to decrypt nametag from events
    for (const event of events) {
      try {
        const content = JSON.parse(event.content);
        if (content.encrypted_nametag) {
          const decrypted = await decryptNametag(
            content.encrypted_nametag,
            this.identity.privateKey
          );
          if (decrypted) {
            logger.debug('Nostr', 'Recovered Unicity ID:', decrypted);
            return decrypted;
          }
        }
      } catch {
        // Try next event
        continue;
      }
    }

    logger.debug('Nostr', 'Could not decrypt Unicity ID from any event');
    return null;
  }

  /**
   * Publish identity binding event on Nostr.
   * Without nametag: publishes base binding (chainPubkey, l1Address, directAddress)
   * using a per-identity d-tag for address discovery.
   * With nametag: delegates to nostr-js-sdk's publishNametagBinding which handles
   * conflict detection (first-seen-wins), encryption, and indexed tags.
   *
   * @returns true if successful, false if nametag is taken by another pubkey
   */
  async publishIdentityBinding(
    chainPubkey: string,
    directAddress: string,
    nametag?: string,
  ): Promise<boolean> {
    this.ensureReady();

    if (!this.identity) {
      throw new SphereError('Identity not set', 'NOT_INITIALIZED');
    }

    const nostrPubkey = this.getNostrPubkey();

    if (nametag) {
      // v2: PROXY:// address scheme removed — DIRECT-only. Publish binding
      // without a proxyAddress; nostr-js-sdk accepts absence as "no proxy".
      try {
        const success = await this.nostrClient!.publishNametagBinding(
          nametag,
          nostrPubkey,
          {
            publicKey: chainPubkey,
            directAddress,
          },
        );

        if (success) {
          logger.debug('Nostr', 'Published identity binding with Unicity ID:', nametag, 'for pubkey:', nostrPubkey.slice(0, 16) + '...');

          // T.8.B — Additionally publish a no-nametag identity binding event
          // carrying capability hints (wireProtocols + assetKinds, §10.4).
          // The nametag binding above uses a different d-tag (hashedNametag)
          // so the two events coexist.
          await this.publishIdentityBindingWithCapabilities(
            chainPubkey, directAddress, nametag,
          );
        }
        return success;
      } catch (error) {
        // publishNametagBinding throws if nametag is already claimed
        if (error instanceof Error && error.message.includes('already claimed')) {
          logger.debug('Nostr', 'Unicity ID already taken:', nametag);
          return false;
        }
        throw error;
      }
    }

    // No nametag — publish our own identity binding event so we can include
    // T.8.B capability hints (the upstream SDK's IdentityBindingParams type
    // does not surface wireProtocols / assetKinds, so we construct the event
    // ourselves; the d-tag formula is identical so this is wire-compatible
    // with older consumers that ignore the extra fields).
    const success = await this.publishIdentityBindingWithCapabilities(
      chainPubkey, directAddress,
    );

    if (success) {
      logger.debug('Nostr', 'Published identity binding (no Unicity ID) for pubkey:', nostrPubkey.slice(0, 16) + '...');
    }
    return success;
  }

  /**
   * T.8.B — Publish a base identity binding event (no nametag) carrying
   * capability hints in the JSON content.
   *
   * Uses the same d-tag formula as the upstream nostr-js-sdk
   * createIdentityBindingEvent (`SHA256('unicity:identity:' + nostrPubkey)`)
   * so this event participates in the same parameterized-replaceable slot
   * (kind 30078 — APP_DATA). Older readers that parse only the four
   * canonical fields (`public_key`, `l1_address`, `direct_address`,
   * `proxy_address`) ignore the additional `wire_protocols` and
   * `asset_kinds` arrays — forward-compatible by construction.
   *
   * Spec refs: §10.4 (capability hints), W20 (assetKinds default).
   */
  private async publishIdentityBindingWithCapabilities(
    chainPubkey: string,
    directAddress: string,
    nametag?: string,
    proxyAddress?: string,
  ): Promise<boolean> {
    const nostrPubkey = this.getNostrPubkey();
    const dTag = bytesToHex(
      sha256Noble(new TextEncoder().encode('unicity:identity:' + nostrPubkey)),
    );

    const content: Record<string, unknown> = {
      public_key: chainPubkey,
      direct_address: directAddress,
      // T.8.B — capability hints (§10.4). Snake_case to match the upstream
      // content schema convention.
      wire_protocols: [...SUPPORTED_WIRE_PROTOCOLS],
      asset_kinds: [...SUPPORTED_ASSET_KINDS],
    };
    // T.8.B — preserve the nametag-bearing identity's `nametag` /
    // `proxy_address` fields on the per-pubkey binding so `resolveTransportPubkeyInfo`
    // (most-recent-by-author) does not return `nametag: undefined` after
    // this event lands. Without this, the no-nametag binding would shadow
    // the nametag-binding's metadata for pubkey-based reverse lookups.
    if (nametag) content.nametag = nametag;
    if (proxyAddress) content.proxy_address = proxyAddress;

    // Mirror the upstream's `t` tag indexing so reverse-lookup by address
    // continues to work. We hash with the same upstream helper to stay in
    // lock-step with NametagUtils.hashAddressForTag().
    const { NametagUtils } = await import('@unicitylabs/nostr-js-sdk');
    const tags: string[][] = [['d', dTag]];
    if (chainPubkey) {
      tags.push(['t', NametagUtils.hashAddressForTag(chainPubkey)]);
    }
    if (directAddress) {
      tags.push(['t', NametagUtils.hashAddressForTag(directAddress)]);
    }

    const event = await this.createEvent(
      EVENT_KINDS.NAMETAG_BINDING,
      JSON.stringify(content),
      tags,
    );
    try {
      await this.publishEvent(event);
      return true;
    } catch (err) {
      logger.warn('Nostr', 'Failed to publish identity binding with capabilities:', err);
      return false;
    }
  }

  // Track broadcast subscriptions
  private broadcastSubscriptions: Map<string, string> = new Map(); // key -> subId

  subscribeToBroadcast(tags: string[], handler: BroadcastHandler): () => void {
    const key = tags.sort().join(':');

    if (!this.broadcastHandlers.has(key)) {
      this.broadcastHandlers.set(key, new Set());

      // Subscribe to relay
      if (this.isConnected() && this.nostrClient) {
        this.subscribeToTags(tags);
      }
    }

    this.broadcastHandlers.get(key)!.add(handler);

    return () => {
      this.broadcastHandlers.get(key)?.delete(handler);
      if (this.broadcastHandlers.get(key)?.size === 0) {
        this.broadcastHandlers.delete(key);
        // Unsubscribe from relay
        const subId = this.broadcastSubscriptions.get(key);
        if (subId && this.nostrClient) {
          this.nostrClient.unsubscribe(subId);
          this.broadcastSubscriptions.delete(key);
        }
      }
    };
  }

  async publishBroadcast(content: string, tags?: string[]): Promise<string> {
    this.ensureReady();

    const eventTags = tags?.map((t) => ['t', t]) ?? [];
    const event = await this.createEvent(EVENT_KINDS.BROADCAST, content, eventTags);

    await this.publishEvent(event);
    return event.id;
  }

  // ===========================================================================
  // Event Subscription
  // ===========================================================================

  onEvent(callback: TransportEventCallback): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  // ===========================================================================
  // Private: Message Handling
  // ===========================================================================

  private async handleEvent(event: NostrEvent): Promise<void> {
    // Issue #275 — two-tier dedup. The persistent set blocks events that
    // were already FULLY processed in a prior session (cross-process
    // dedup). The in-flight set blocks concurrent arrivals via multiple
    // subscriptions within the same process. Neither set is added to
    // until we've confirmed processing — at-least-once depends on
    // failed TOKEN_TRANSFER events being replayable on next reconnect.
    if (event.id && this.processedEventIds.has(event.id)) {
      return;
    }
    if (event.id && this.inFlightEventIds.has(event.id)) {
      return;
    }
    if (event.id) {
      this.inFlightEventIds.add(event.id);
    }

    logger.debug('Nostr', 'Processing event kind:', event.kind, 'id:', event.id?.slice(0, 12));
    try {
      // At-least-once invariant: TOKEN_TRANSFER events are gated on
      // durability — `handleTokenTransfer` returns `true` only when
      // every registered handler reported the inbound token(s)
      // durably persisted (IPFS pin + OrbitDB ref + aggregator
      // pointer for the Profile provider). When `false`, we do NOT
      // advance `lastEventTs` AND we do NOT add to `processedEventIds`,
      // so the event is re-replayed on the next reconnect (idempotent
      // via addToken stateHash dedup).
      //
      // Other wallet kinds (DM, payment-request, payment-request-
      // response) retain the legacy "advance on completion"
      // semantics — their persistence model is in-memory + KV save
      // which is synchronous on save() return, so the gap that
      // motivated the invariant (debounced IPFS pin) does not apply.
      let tokenTransferDurable = true;
      switch (event.kind) {
        case EVENT_KINDS.DIRECT_MESSAGE:
          await this.handleDirectMessage(event);
          break;
        case EventKinds.GIFT_WRAP:
          logger.debug('Nostr', 'Handling gift wrap (NIP-17 DM)');
          await this.handleGiftWrap(event);
          break;
        case EVENT_KINDS.TOKEN_TRANSFER:
          // Issue #272: cooldown gate. Skip processing entirely when a
          // recent durability miss for this event ID is still within
          // its cooldown window. Without this, relay reconnect immediately
          // re-fires the failing event and the receive pipeline (parse +
          // crypto verify + flush + HEAD-verify) burns CPU on every retry
          // before refusing the ack again. The cooldown map is now
          // persisted (issue #275) so the bounded replay budget
          // (`DURABILITY_MAX_REPLAY_ATTEMPTS = 3`) accumulates across
          // process restarts rather than resetting per-process.
          if (event.id && this.isInDurabilityCooldown(event.id)) {
            logger.debug(
              'Nostr',
              `[AT-LEAST-ONCE] TOKEN_TRANSFER ${event.id.slice(0, 12)} in durability cooldown — skipping replay`,
            );
            return;
          }
          tokenTransferDurable = await this.handleTokenTransfer(event);
          break;
        case EVENT_KINDS.PAYMENT_REQUEST:
          await this.handlePaymentRequest(event);
          break;
        case EVENT_KINDS.PAYMENT_REQUEST_RESPONSE:
          await this.handlePaymentRequestResponse(event);
          break;
        case EVENT_KINDS.BROADCAST:
          this.handleBroadcast(event);
          break;
      }

      // Persist the latest event timestamp for resumption on reconnect.
      // Only update for wallet event kinds (not chat/broadcast).
      // Skip for TOKEN_TRANSFER when the handler reported non-durable —
      // re-replay on next reconnect protects against silent loss when
      // IPFS pin / OrbitDB write / aggregator publish fails.
      //
      // Issue #275: cursor advance and `processedEventIds` add MUST move
      // together — they're the two halves of "this event is done." If
      // we mark processed without advancing the cursor, the relay will
      // re-deliver the event and we'll spin forever in dedup-skip. If
      // we advance the cursor without marking processed, a process
      // restart will refetch and reprocess the event (wasteful but
      // safe). The lockstep below is the at-least-once invariant.
      if (event.created_at && this.storage && this.keyManager) {
        const kind = event.kind;
        if (
          kind === EVENT_KINDS.DIRECT_MESSAGE ||
          kind === EVENT_KINDS.PAYMENT_REQUEST ||
          kind === EVENT_KINDS.PAYMENT_REQUEST_RESPONSE
        ) {
          this.updateLastEventTimestamp(event.created_at);
          this.markEventProcessed(event.id);
        } else if (kind === EVENT_KINDS.TOKEN_TRANSFER) {
          if (tokenTransferDurable) {
            // Issue #272: success — drop any prior cooldown tracking
            // so a future event with the same ID (which shouldn't
            // normally happen, but happens during cold-start replay
            // floods on Nostr reconnect) gets a fresh budget.
            if (event.id) this.failedEventCooldowns.delete(event.id);
            this.updateLastEventTimestamp(event.created_at);
            this.markEventProcessed(event.id);
          } else if (event.id) {
            // Issue #272: bounded replay budget. `recordDurabilityMiss`
            // increments the per-event attempt counter, arms an
            // exponential cooldown, and returns `true` once the budget
            // is exhausted — at which point we advance the cursor to
            // unstick subsequent events behind this one.
            const shouldAdvance = this.recordDurabilityMiss(event.id);
            if (shouldAdvance) {
              logger.warn(
                'Nostr',
                `[AT-LEAST-ONCE] TOKEN_TRANSFER ${event.id.slice(0, 12)} exhausted ${NostrTransportProvider.DURABILITY_MAX_REPLAY_ATTEMPTS} durability replay attempts — advancing cursor; operator should investigate local OrbitDB/IPFS-pin/publish failures.`,
              );
              this.updateLastEventTimestamp(event.created_at);
              // Mark processed so subsequent cross-process replays
              // short-circuit at the top of handleEvent. Without this,
              // a budget-exhausted event would replay forever after
              // process restart (its event ID isn't in `processedEventIds`
              // and the persisted cooldowns may have expired).
              this.markEventProcessed(event.id);
            } else {
              const entry = this.failedEventCooldowns.get(event.id);
              const cooldownMs = entry ? Math.max(0, entry.nextRetryAt - Date.now()) : 0;
              logger.warn(
                'Nostr',
                `[AT-LEAST-ONCE] TOKEN_TRANSFER ${event.id.slice(0, 12)} not durable — leaving 'since' at ${this.lastEventTs}; cooldown ${cooldownMs}ms (attempt ${entry?.attempts ?? '?'}/${NostrTransportProvider.DURABILITY_MAX_REPLAY_ATTEMPTS}).`,
              );
              // Persist the cooldown bump so a process restart sees
              // the accumulated attempt count.
              this.schedulePersistDedup();
            }
          } else {
            // Defensive: no event.id means we can't track cooldown or
            // advance idempotently. Preserve legacy behavior.
            logger.warn(
              'Nostr',
              `[AT-LEAST-ONCE] TOKEN_TRANSFER (no id) not durable — leaving 'since' at ${this.lastEventTs}; event will replay on next reconnect`,
            );
          }
        } else {
          // BROADCAST / GIFT_WRAP: no cursor tracking on the wallet
          // since-filter (GIFT_WRAP uses lastDmEventTs which the DM
          // handler advances; BROADCAST has no since-resume). Still
          // mark processed so multi-subscription concurrent arrivals
          // don't double-emit to handlers.
          this.markEventProcessed(event.id);
        }
      } else {
        // No created_at or no storage — best-effort mark to dedup
        // within session. Without storage we can't persist anyway.
        this.markEventProcessed(event.id);
      }
    } catch (error) {
      logger.debug('Nostr', 'Failed to handle event:', error);
    } finally {
      // Always release in-flight slot so a retry (next reconnect) can
      // re-enter handleEvent. Persistent dedup at the top will block
      // duplicates of fully-processed events.
      if (event.id) {
        this.inFlightEventIds.delete(event.id);
      }
    }
  }

  /**
   * Issue #275 — add an event ID to the persistent dedup set and
   * schedule a debounced write. FIFO-eviction keeps the set bounded
   * at `LIMITS.PROCESSED_EVENT_IDS_CAP`.
   */
  private markEventProcessed(eventId: string | undefined): void {
    if (!eventId) return;
    if (this.processedEventIds.has(eventId)) return;
    this.processedEventIds.add(eventId);
    // FIFO eviction: Set preserves insertion order, so keys().next().value
    // is the oldest entry. Evict in a single step (cheap) per insert at
    // capacity; no full re-sort needed.
    while (this.processedEventIds.size > LIMITS.PROCESSED_EVENT_IDS_CAP) {
      const oldest = this.processedEventIds.keys().next().value;
      if (oldest === undefined) break;
      this.processedEventIds.delete(oldest);
    }
    this.schedulePersistDedup();
  }

  /**
   * Issue #275 — schedule a debounced write of the persistent dedup
   * sets to storage. Coalesces a burst of EOSE-replay arrivals into a
   * single storage transaction. Subsequent calls within the debounce
   * window are no-ops (timer already armed).
   */
  private schedulePersistDedup(): void {
    if (!this.storage || !this.keyManager) return;
    if (this.persistDedupTimer) return;
    this.persistDedupTimer = setTimeout(() => {
      this.persistDedupTimer = null;
      this.persistDedupNow().catch((err) => {
        logger.debug('Nostr', 'Persisted dedup write failed (will retry on next mark):', err);
      });
    }, LIMITS.PROCESSED_EVENT_IDS_FLUSH_MS);
  }

  /**
   * Issue #275 — write the persistent dedup sets to storage. Serialized
   * via `persistDedupInFlight` so concurrent timer fires (debounce + a
   * forced flush) don't race on the underlying KV write.
   */
  private async persistDedupNow(): Promise<void> {
    if (!this.storage || !this.keyManager) return;
    // Serialize against any in-flight write — proper-lockfile in
    // FileStorageProvider would block anyway, but IndexedDB doesn't,
    // and overlapping writes risk last-writer-wins of a stale snapshot.
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
    if (!this.storage || !this.keyManager) return;
    const pubkey = this.keyManager.getPublicKeyHex();
    const prefix = pubkey.slice(0, 16);
    const eventsKey = `${STORAGE_KEYS_GLOBAL.PROCESSED_WALLET_EVENT_IDS}_${prefix}`;
    const cooldownsKey = `${STORAGE_KEYS_GLOBAL.FAILED_EVENT_COOLDOWNS}_${prefix}`;

    // Snapshot under sync — Set/Map iteration is stable but a concurrent
    // markEventProcessed can mutate the underlying collection. Array.from
    // captures a stable view for serialization.
    const ids = Array.from(this.processedEventIds);
    const cooldownsArr: Array<[string, { nextRetryAt: number; attempts: number }]> = Array.from(
      this.failedEventCooldowns.entries(),
    );

    // Write events + cooldowns independently — they target distinct
    // KV keys so a partial failure on one shouldn't block the other.
    try {
      await this.storage.set(eventsKey, JSON.stringify(ids));
    } catch (err) {
      logger.debug('Nostr', 'Persisted dedup: events write failed:', err);
    }
    try {
      await this.storage.set(cooldownsKey, JSON.stringify(cooldownsArr));
    } catch (err) {
      logger.debug('Nostr', 'Persisted dedup: cooldowns write failed:', err);
    }
  }

  /**
   * Issue #275 — hydrate the persistent dedup sets from storage on the
   * first connect/fetchPendingEvents per identity. Idempotent: subsequent
   * calls are no-ops once `dedupHydrated` is true.
   *
   * Failure modes (storage read throw, JSON parse error, malformed
   * data) all degrade to "start fresh" — the wallet still works, just
   * pays the cross-process re-dispatch tax once until the next write
   * cycle repopulates the disk.
   */
  private async hydrateProcessedDedup(): Promise<void> {
    if (this.dedupHydrated) return;
    if (!this.storage || !this.keyManager) {
      this.dedupHydrated = true;
      return;
    }
    const pubkey = this.keyManager.getPublicKeyHex();
    const prefix = pubkey.slice(0, 16);
    const eventsKey = `${STORAGE_KEYS_GLOBAL.PROCESSED_WALLET_EVENT_IDS}_${prefix}`;
    const cooldownsKey = `${STORAGE_KEYS_GLOBAL.FAILED_EVENT_COOLDOWNS}_${prefix}`;

    try {
      const raw = await this.storage.get(eventsKey);
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
      logger.debug('Nostr', 'hydrateProcessedDedup events parse/read failed:', err);
    }

    try {
      const raw = await this.storage.get(cooldownsKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const now = Date.now();
          let dropped = 0;
          for (const entry of parsed) {
            if (
              Array.isArray(entry) &&
              entry.length === 2 &&
              typeof entry[0] === 'string' &&
              entry[1] !== null &&
              typeof entry[1] === 'object'
            ) {
              const [eventId, meta] = entry as [string, unknown];
              const m = meta as { nextRetryAt?: unknown; attempts?: unknown };
              const nextRetryAt = typeof m.nextRetryAt === 'number' ? m.nextRetryAt : NaN;
              const attempts = typeof m.attempts === 'number' ? m.attempts : NaN;
              if (
                Number.isFinite(nextRetryAt) &&
                Number.isFinite(attempts) &&
                attempts >= 1 &&
                attempts < NostrTransportProvider.DURABILITY_MAX_REPLAY_ATTEMPTS
              ) {
                // Drop entries whose cooldown elapsed more than one
                // COOLDOWN_MAX_MS ago — the cooldown is meaningless and
                // we'd just keep stale clutter. Keep recently-expired
                // ones because the attempt counter still matters for
                // budget accumulation.
                const elapsed = now - nextRetryAt;
                if (elapsed > NostrTransportProvider.DURABILITY_COOLDOWN_MAX_MS * 2) {
                  dropped++;
                  continue;
                }
                this.failedEventCooldowns.set(eventId, { nextRetryAt, attempts });
              }
            }
          }
          if (dropped > 0) {
            logger.debug('Nostr', `hydrateProcessedDedup: dropped ${dropped} stale cooldown entries`);
          }
        }
      }
    } catch (err) {
      logger.debug('Nostr', 'hydrateProcessedDedup cooldowns parse/read failed:', err);
    }

    this.dedupHydrated = true;
    logger.debug(
      'Nostr',
      `[#275] Persisted dedup hydrated: ${this.processedEventIds.size} event IDs, ${this.failedEventCooldowns.size} cooldown entries`,
    );
  }

  /**
   * Save the max event timestamp to storage (fire-and-forget, no await needed by caller).
   * Uses in-memory `lastEventTs` to avoid read-before-write race conditions
   * when multiple events arrive in quick succession.
   */
  private updateLastEventTimestamp(createdAt: number): void {
    if (!this.storage || !this.keyManager) return;
    if (createdAt <= this.lastEventTs) return;

    this.lastEventTs = createdAt;
    const pubkey = this.keyManager.getPublicKeyHex();
    const storageKey = `${STORAGE_KEYS_GLOBAL.LAST_WALLET_EVENT_TS}_${pubkey.slice(0, 16)}`;

    this.storage.set(storageKey, createdAt.toString()).catch(err => {
      logger.debug('Nostr', 'Failed to save last event timestamp:', err);
    });
  }

  /**
   * Issue #272 — return true iff this event ID has a live durability
   * cooldown. Cleans up the entry when the cooldown has expired so the
   * map doesn't accumulate stale entries on the read path.
   */
  private isInDurabilityCooldown(eventId: string): boolean {
    const entry = this.failedEventCooldowns.get(eventId);
    if (!entry) return false;
    if (Date.now() >= entry.nextRetryAt) {
      // Cooldown expired — leave the attempts count INTACT (we still
      // need it so the next failure increments correctly toward the
      // MAX_REPLAY_ATTEMPTS budget). The entry will be replaced on
      // the next miss or deleted on the next success.
      return false;
    }
    return true;
  }

  /**
   * Issue #272 — record a durability miss for this event ID and arm
   * an exponential cooldown. Returns `true` when the per-event replay
   * budget (`DURABILITY_MAX_REPLAY_ATTEMPTS`) is exhausted — in that
   * case the caller should advance the `since` cursor (the entry is
   * deleted by this method to free the slot) so subsequent events
   * are not blocked indefinitely behind one persistently-failing one.
   * Local-durability is decoupled from this gate (issue #272 background-
   * verify patch in `flush-scheduler.ts`), so a persistent miss after
   * the budget exhausts indicates a genuine local persistence failure
   * (OrbitDB write timeout / pin POST != 200 / monotonicity violation)
   * that re-replay alone cannot resolve.
   */
  private recordDurabilityMiss(eventId: string): boolean {
    const prior = this.failedEventCooldowns.get(eventId);
    const attempts = (prior?.attempts ?? 0) + 1;

    if (attempts >= NostrTransportProvider.DURABILITY_MAX_REPLAY_ATTEMPTS) {
      this.failedEventCooldowns.delete(eventId);
      return true;
    }

    // LRU-style cap: when at capacity, evict the oldest insertion
    // (Map preserves insertion order, so the first key IS the oldest).
    // Single-victim eviction per insert is sufficient under typical
    // replay-flood pressure (14 unique IDs in the §C.2 forensics; cap
    // of 256 covers >18x that headroom).
    if (this.failedEventCooldowns.size >= NostrTransportProvider.DURABILITY_COOLDOWN_MAP_CAP) {
      const oldestKey = this.failedEventCooldowns.keys().next().value;
      if (oldestKey !== undefined) {
        this.failedEventCooldowns.delete(oldestKey);
      }
    }

    const delayMs = Math.min(
      NostrTransportProvider.DURABILITY_COOLDOWN_BASE_MS * Math.pow(2, attempts - 1),
      NostrTransportProvider.DURABILITY_COOLDOWN_MAX_MS,
    );
    this.failedEventCooldowns.set(eventId, {
      nextRetryAt: Date.now() + delayMs,
      attempts,
    });
    return false;
  }

  /** Persist the max DM (gift-wrap) event timestamp for the since filter on next connect. */
  private updateLastDmEventTimestamp(createdAt: number): void {
    if (!this.storage || !this.keyManager) return;
    if (createdAt <= this.lastDmEventTs) return;

    this.lastDmEventTs = createdAt;
    const pubkey = this.keyManager.getPublicKeyHex();
    const storageKey = `${STORAGE_KEYS_GLOBAL.LAST_DM_EVENT_TS}_${pubkey.slice(0, 16)}`;

    this.storage.set(storageKey, createdAt.toString()).catch(err => {
      logger.debug('Nostr', 'Failed to save last DM event timestamp:', err);
    });
  }

  private async handleDirectMessage(event: NostrEvent): Promise<void> {
    // NIP-04 (kind 4) is deprecated for DMs - only used for legacy token transfers
    // DMs should come through NIP-17 (kind 1059 gift wrap) via handleGiftWrap
    // This handler is kept for backwards compatibility but does NOT dispatch to messageHandlers
    logger.debug('Nostr', 'Ignoring NIP-04 kind 4 event (DMs use NIP-17):', event.id?.slice(0, 12));
  }

  private async handleGiftWrap(event: NostrEvent): Promise<void> {
    if (!this.identity || !this.keyManager) {
      logger.debug('Nostr', 'handleGiftWrap: no identity/keyManager');
      return;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pm = NIP17.unwrap(event as any, this.keyManager);

      // Persist DM timestamp after successful unwrap so failed decryptions
      // do not advance the since filter and permanently skip events.
      // Use real wall-clock time, NOT event.created_at — NIP-17 gift wraps
      // randomize created_at by ±2 days for privacy, so it can be in the future.
      this.updateLastDmEventTimestamp(Math.floor(Date.now() / 1000));

      logger.debug('Nostr', 'Gift wrap unwrapped, sender:', pm.senderPubkey?.slice(0, 16), 'kind:', pm.kind);

      // Handle self-wrap (sent message copy for relay replay)
      if (pm.senderPubkey === this.keyManager.getPublicKeyHex()) {
        try {
          const parsed = JSON.parse(pm.content);
          if (parsed?.selfWrap && parsed.recipientPubkey) {
            logger.debug('Nostr', 'Self-wrap replay for recipient:', parsed.recipientPubkey?.slice(0, 16));
            const message: IncomingMessage = {
              id: parsed.originalId || pm.eventId,
              senderTransportPubkey: pm.senderPubkey,
              senderNametag: parsed.senderNametag,
              recipientTransportPubkey: parsed.recipientPubkey,
              content: parsed.text ?? '',
              timestamp: pm.timestamp * 1000,
              encrypted: true,
              isSelfWrap: true,
            };
            for (const handler of this.messageHandlers) {
              try { handler(message); } catch (e) { logger.debug('Nostr', 'Self-wrap handler error:', e); }
            }
            return;
          }
        } catch {
          // Not JSON self-wrap
        }
        logger.debug('Nostr', 'Skipping own non-self-wrap message');
        return;
      }

      // Handle read receipts (kind 15)
      if (isReadReceipt(pm)) {
        logger.debug('Nostr', 'Read receipt from:', pm.senderPubkey?.slice(0, 16), 'for:', pm.replyToEventId);
        if (pm.replyToEventId) {
          const receipt: IncomingReadReceipt = {
            senderTransportPubkey: pm.senderPubkey,
            messageEventId: pm.replyToEventId,
            timestamp: pm.timestamp * 1000,
          };
          for (const handler of this.readReceiptHandlers) {
            try { handler(receipt); } catch (e) { logger.debug('Nostr', 'Read receipt handler error:', e); }
          }
        }
        return;
      }

      // Handle composing indicators (kind 25050)
      if (pm.kind === COMPOSING_INDICATOR_KIND) {
        let senderNametag: string | undefined;
        let expiresIn = 30000;
        try {
          const parsed = JSON.parse(pm.content);
          senderNametag = parsed.senderNametag || undefined;
          expiresIn = parsed.expiresIn ?? 30000;
        } catch {
          // Payload parse failed — use defaults
        }
        const indicator = {
          senderPubkey: pm.senderPubkey,
          senderNametag,
          expiresIn,
        };
        logger.debug('Nostr', 'Composing indicator from:', indicator.senderNametag || pm.senderPubkey?.slice(0, 16));
        for (const handler of this.composingHandlers) {
          try { handler(indicator); } catch (e) { logger.debug('Nostr', 'Composing handler error:', e); }
        }
        return;
      }

      // Handle typing indicators (JSON content with type: 'typing')
      try {
        const parsed = JSON.parse(pm.content);
        if (parsed?.type === 'typing') {
          logger.debug('Nostr', 'Typing indicator from:', pm.senderPubkey?.slice(0, 16));
          const indicator: IncomingTypingIndicator = {
            senderTransportPubkey: pm.senderPubkey,
            senderNametag: parsed.senderNametag,
            timestamp: pm.timestamp * 1000,
          };
          for (const handler of this.typingIndicatorHandlers) {
            try { handler(indicator); } catch (e) { logger.debug('Nostr', 'Typing handler error:', e); }
          }
          return;
        }
      } catch {
        // Not JSON — continue to chat message handling
      }

      if (!isChatMessage(pm)) {
        logger.debug('Nostr', 'Skipping unknown message kind:', pm.kind);
        return;
      }

      // Sphere app wraps DM content as JSON: {senderNametag, text}
      let content = pm.content;
      let senderNametag: string | undefined;
      try {
        const parsed = JSON.parse(content);
        if (typeof parsed === 'object' && parsed.text !== undefined) {
          content = parsed.text;
          senderNametag = parsed.senderNametag || undefined;
        }
      } catch {
        // Plain text — use as-is
      }

      logger.debug('Nostr', 'DM received from:', senderNametag || pm.senderPubkey?.slice(0, 16), 'content:', content?.slice(0, 50));

      const message: IncomingMessage = {
        // Use outer gift wrap event.id so it matches the sender's stored giftWrap.id.
        // This ensures read receipts reference an ID the sender recognizes.
        id: event.id,
        senderTransportPubkey: pm.senderPubkey,
        senderNametag,
        content,
        timestamp: pm.timestamp * 1000,
        encrypted: true,
      };

      this.emitEvent({ type: 'message:received', timestamp: Date.now() });

      if (this.messageHandlers.size === 0) {
        logger.debug('Nostr', 'No message handlers registered, buffering message for later delivery');
        this.pendingMessages.push(message);
      } else {
        logger.debug('Nostr', 'Dispatching to', this.messageHandlers.size, 'handlers');
        for (const handler of this.messageHandlers) {
          try {
            handler(message);
          } catch (error) {
            logger.debug('Nostr', 'Message handler error:', error);
          }
        }
      }
    } catch (err) {
      // Expected for gift wraps meant for other recipients
      logger.debug('Nostr', 'Gift wrap decrypt failed (expected if not for us):', (err as Error)?.message?.slice(0, 50));
    }
  }

  private async handleTokenTransfer(event: NostrEvent): Promise<boolean> {
    if (!this.identity) return true;

    // Decrypt content (the `token_transfer:` prefix is stripped inside
    // `decryptContent` → `stripContentPrefix`, so by the time we get
    // `content` it's a plain JSON document — no extra trimming required
    // here).
    const content = await this.decryptContent(event.content, event.pubkey);

    // T.2.E — shape-agnostic inbound parsing.
    //
    // `decodeTransferPayload` (T.1.D) is structurally paranoid: it parses
    // the JSON, runs `isUxfTransferPayload`, and either returns a typed
    // union value or throws `BUNDLE_REJECTED_MALFORMED_ENVELOPE`. The
    // outer `handleEvent` switch catches this error and logs at debug
    // level — same fail-soft behavior as the pre-T.2.E `JSON.parse` path,
    // which would have thrown `SyntaxError` on bad bytes.
    //
    // The handler downstream (PaymentsModule) discriminates by shape:
    // `kind === 'uxf-car' | 'uxf-cid'` routes to the new UXF receive
    // path (T.7.A), absence of `kind` routes to the legacy adapter
    // (existing four-shape `processTokenTransfer` flow).
    //
    // Note that `decodeTransferPayload` deliberately collapses every
    // failure mode (non-JSON, wrong type, missing fields, unknown
    // discriminator) to a single error code so we don't have to fan-out
    // here — the receiver's idempotency layer (§5.6) treats every kind
    // of malformed envelope the same way: drop and move on.
    const payload = decodeTransferPayload(content);

    const transfer: IncomingTokenTransfer = {
      id: event.id,
      senderTransportPubkey: event.pubkey,
      payload,
      timestamp: event.created_at * 1000,
    };

    this.emitEvent({ type: 'transfer:received', timestamp: Date.now() });

    // At-least-once invariant: collect durability signal from every
    // registered handler. If ANY handler returns `false` (could not
    // persist), or throws, we treat the whole event as non-durable so
    // the transport refuses to advance `lastEventTs`. The legacy
    // contract (handlers returning `void` / `undefined`) maps to
    // `true` (durable) so existing wrappers do not regress to
    // "never ack".
    //
    // Issue #223 / #247 — the pre-Mux window (between
    // `transport.connect()` and `mux.suppressSubscriptions()` in
    // Sphere.ensureTransportMux) leaves this provider's own subscription
    // live while PaymentsModule has registered its handler on the
    // *AddressTransportAdapter*, not on the outer provider. An empty
    // `transferHandlers` set previously produced a vacuous
    // `allDurable = true`, which advanced `lastEventTs` and silently
    // dropped the event; the issue #223 fix flipped it to `false`,
    // which produced the persistent "TOKEN_TRANSFER ... not durable"
    // replay storm observed in manual-test-full-recovery.sh.
    //
    // Issue #247 fix: buffer the transfer for delivery to the FIRST
    // handler that registers (`onTokenTransfer` drains the buffer).
    // Still return `false` to keep `lastEventTs` pinned — if this
    // process exits before any handler registers, the event must
    // replay on next reconnect. The drain advances `lastEventTs`
    // per-event on successful delivery, so a handler that arrives
    // later in the same session avoids the replay.
    if (this.transferHandlers.size === 0) {
      this.pendingTransfers.push({ transfer, createdAtSec: event.created_at });
      logger.debug(
        'Nostr',
        `Buffered TOKEN_TRANSFER ${event.id?.slice(0, 12)} — no handler registered yet ` +
          `(buffer size=${this.pendingTransfers.length})`,
      );
      return false;
    }

    let allDurable = true;
    for (const handler of this.transferHandlers) {
      try {
        const result = await handler(transfer);
        if (result === false) allDurable = false;
      } catch (error) {
        logger.debug('Nostr', 'Transfer handler error:', error);
        allDurable = false;
      }
    }
    return allDurable;
  }

  private async handlePaymentRequest(event: NostrEvent): Promise<void> {
    if (!this.identity) return;

    try {
      // Decrypt content
      const content = await this.decryptContent(event.content, event.pubkey);
      const requestData = JSON.parse(content) as {
        requestId: string;
        amount: string;
        coinId: string;
        message?: string;
        recipientNametag?: string;
        metadata?: Record<string, unknown>;
      };

      const request: IncomingPaymentRequest = {
        id: event.id,
        senderTransportPubkey: event.pubkey,
        senderNametag: requestData.recipientNametag,
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

      logger.debug('Nostr', 'Received payment request:', request.id);

      for (const handler of this.paymentRequestHandlers) {
        try {
          handler(request);
        } catch (error) {
          logger.debug('Nostr', 'Payment request handler error:', error);
        }
      }
    } catch (error) {
      logger.debug('Nostr', 'Failed to handle payment request:', error);
    }
  }

  private async handlePaymentRequestResponse(event: NostrEvent): Promise<void> {
    if (!this.identity) return;

    try {
      // Decrypt content
      const content = await this.decryptContent(event.content, event.pubkey);
      const responseData = JSON.parse(content) as {
        requestId: string;
        responseType: 'accepted' | 'rejected' | 'paid';
        message?: string;
        transferId?: string;
      };

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

      logger.debug('Nostr', 'Received payment request response:', response.id, 'type:', responseData.responseType);

      for (const handler of this.paymentRequestResponseHandlers) {
        try {
          handler(response);
        } catch (error) {
          logger.debug('Nostr', 'Payment request response handler error:', error);
        }
      }
    } catch (error) {
      logger.debug('Nostr', 'Failed to handle payment request response:', error);
    }
  }

  private handleBroadcast(event: NostrEvent): void {
    const tags = event.tags
      .filter((t: string[]) => t[0] === 't')
      .map((t: string[]) => t[1]);

    const broadcast: IncomingBroadcast = {
      id: event.id,
      authorTransportPubkey: event.pubkey,
      content: event.content,
      tags,
      timestamp: event.created_at * 1000,
    };

    // Find matching handlers
    for (const [key, handlers] of this.broadcastHandlers) {
      const subscribedTags = key.split(':');
      if (tags.some((t) => subscribedTags.includes(t))) {
        for (const handler of handlers) {
          try {
            handler(broadcast);
          } catch (error) {
            logger.debug('Nostr', 'Broadcast handler error:', error);
          }
        }
      }
    }
  }

  // ===========================================================================
  // Private: Event Creation & Publishing
  // ===========================================================================

  private async createEvent(
    kind: number,
    content: string,
    tags: string[][]
  ): Promise<NostrEvent> {
    if (!this.identity) throw new SphereError('Identity not set', 'NOT_INITIALIZED');
    if (!this.keyManager) throw new SphereError('KeyManager not initialized', 'NOT_INITIALIZED');

    // Create and sign event using SDK
    const signedEvent = NostrEventClass.create(this.keyManager, {
      kind,
      content,
      tags,
    });

    // Convert to our interface
    const event: NostrEvent = {
      id: signedEvent.id,
      kind: signedEvent.kind,
      content: signedEvent.content,
      tags: signedEvent.tags,
      pubkey: signedEvent.pubkey,
      created_at: signedEvent.created_at,
      sig: signedEvent.sig,
    };

    return event;
  }

  private async createEncryptedEvent(
    kind: number,
    content: string,
    tags: string[][]
  ): Promise<NostrEvent> {
    if (!this.keyManager) throw new SphereError('KeyManager not initialized', 'NOT_INITIALIZED');

    // Extract recipient pubkey from tags (first 'p' tag)
    const recipientTag = tags.find((t) => t[0] === 'p');
    if (!recipientTag || !recipientTag[1]) {
      throw new SphereError('No recipient pubkey in tags for encryption', 'VALIDATION_ERROR');
    }
    const recipientPubkey = recipientTag[1];

    // Encrypt content with NIP-04 (using hex variant for string keys)
    const encrypted = await NIP04.encryptHex(
      content,
      this.keyManager.getPrivateKeyHex(),
      recipientPubkey
    );

    return this.createEvent(kind, encrypted, tags);
  }

  private async publishEvent(event: NostrEvent): Promise<void> {
    if (!this.nostrClient) {
      throw new SphereError('NostrClient not initialized', 'NOT_INITIALIZED');
    }

    const MAX_ATTEMPTS = 3;
    const RETRY_BASE_DELAY_MS = 500;
    const RETRY_JITTER_MS = 200;

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      // Snapshot this.nostrClient at the top of each iteration. Using a local
      // reference (instead of `this.nostrClient.publishEvent(...)`) prevents a
      // concurrent disconnect() during the subsequent await from turning the
      // call into a TypeError on null.
      const client = this.nostrClient;
      if (!client) {
        throw new SphereError('Transport disconnected during retry', 'TRANSPORT_ERROR');
      }

      try {
        // Re-create SDK event each attempt to avoid reusing the same event ID
        // in nostr-js-sdk's pendingOks map (which would leak timers from prior attempts)
        const sdkEvent = NostrEventClass.fromJSON(event);
        await client.publishEvent(sdkEvent);
        return;
      } catch (err: unknown) {
        lastError = err;
        const rawMessage = err instanceof Error ? err.message : String(err);

        // Only retry relay-level rejections (nostr-js-sdk wraps these as "Event rejected: <reason>")
        // or relay broadcast failures ("sent 0 of N"). All other errors (disconnected, closed,
        // no connected relays) are non-transient and should fail immediately.
        // Locale-invariant match with `en-US` to avoid Turkish-locale surprises
        // where `'I'.toLowerCase()` yields `'ı'` (dotless i).
        const lowered = rawMessage.toLocaleLowerCase('en-US');
        const isRelayRejection =
          lowered.startsWith('event rejected:') ||
          lowered.startsWith('sent 0 of');

        if (!isRelayRejection || attempt === MAX_ATTEMPTS) {
          break;
        }

        // Add jitter to desynchronize retries across concurrent clients
        const delay = RETRY_BASE_DELAY_MS + Math.floor(Math.random() * RETRY_JITTER_MS);
        logger.debug(
          'Nostr',
          `publishEvent attempt ${attempt}/${MAX_ATTEMPTS} failed (${rawMessage}); retrying in ${delay}ms`
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    logger.error('Nostr', `publishEvent failed after ${MAX_ATTEMPTS} attempts: ${reason}`);
    // Chain the original error as `cause` to preserve context for debugging
    throw new SphereError(
      `Failed to publish event: ${reason}`,
      'TRANSPORT_ERROR',
      lastError
    );
  }

  /**
   * Publish an event with verification: after publishing, query the relay to
   * confirm the event was stored. Retries up to `maxAttempts` times on failure.
   *
   * This is critical for token transfers and DMs where silent loss means
   * funds or messages disappear. The nostr-js-sdk's publishEvent resolves on
   * a 5s timeout even without relay confirmation, so verification is needed.
   */
  private async publishWithVerification(
    event: NostrEvent,
    maxAttempts: number = 3,
    label: string = 'event',
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.publishEvent(event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Permanent rejection — don't retry (e.g., "Event rejected: invalid signature")
        if (msg.includes('Event rejected') && !msg.includes('rate') && !msg.includes('limit')) {
          throw err;
        }
        if (attempt === maxAttempts) throw err;
        logger.debug('Nostr', `${label} publish attempt ${attempt} failed (${msg}), retrying in ${attempt}s...`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }

      // Verify: query the relay for this specific event by ID.
      // Jittered delay to let relay index + reduce temporal fingerprinting.
      await new Promise(r => setTimeout(r, 300 + Math.random() * 1200));
      try {
        const found = await this.queryEvents({
          ids: [event.id],
          limit: 1,
        });
        if (found.length > 0) {
          if (attempt > 1) {
            logger.debug('Nostr', `${label} verified on relay after ${attempt} attempt(s)`);
          }
          return; // confirmed on relay
        }
      } catch {
        // Query failed — can't verify. If this is the last attempt,
        // accept the publish as best-effort.
        if (attempt === maxAttempts) {
          logger.debug('Nostr', `${label} verification query failed — accepting publish as best-effort`);
          return;
        }
      }

      // Event not found on relay — retry with increasing backoff
      if (attempt < maxAttempts) {
        const delay = Math.min(2000 * attempt, 10000);
        logger.debug('Nostr', `${label} not found on relay, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw new SphereError(
          `${label} not verified on relay after ${maxAttempts} attempts — delivery failed`,
          'TRANSPORT_ERROR',
        );
      }
    }
  }

  /**
   * Issue #166 P2 #3 — Verify a previously published TOKEN_TRANSFER
   * event is still persisted by querying the relay for its event id.
   *
   * Implements the {@link TransportProvider.verifyTokenTransferRetained}
   * contract: NEVER throws — converts query failures (no connection,
   * timeout, malformed response) to `'unverifiable'`. The verifier
   * worker treats `'unverifiable'` as "retry next cycle"; only
   * `'missing'` triggers a retention-warning event.
   */
  async verifyTokenTransferRetained(
    eventId: string,
  ): Promise<'retained' | 'missing' | 'unverifiable'> {
    if (typeof eventId !== 'string' || eventId.length === 0) {
      // Defense-in-depth: empty id would query every event on the
      // relay (huge response). Treat as unverifiable.
      return 'unverifiable';
    }
    if (!this.nostrClient?.isConnected()) {
      return 'unverifiable';
    }
    try {
      const found = await this.queryEvents({
        ids: [eventId],
        limit: 1,
      });
      return found.length > 0 ? 'retained' : 'missing';
    } catch {
      // Any query throw — relay timeout, lost connection mid-query,
      // unparseable response — degrades to unverifiable so the worker
      // does not false-positive a retention warning.
      return 'unverifiable';
    }
  }

  async fetchPendingEvents(): Promise<void> {
    if (!this.nostrClient?.isConnected() || !this.keyManager) {
      throw new SphereError('Transport not connected', 'TRANSPORT_ERROR');
    }

    // Issue #275 — hydrate persistent dedup BEFORE pulling EOSE backlog.
    // Without this, the first CLI command of a new process would walk
    // the full relay backlog once (pre-fix #275 §C soak: 169 dispatches
    // across 15 unique ids). This is the same hook installed in
    // `subscribeToEvents` for the long-lived subscription path; CLIs
    // that only call `fetchPendingEvents` (no persistent subscription)
    // also need the hydrate to take effect.
    await this.hydrateProcessedDedup();

    // Issue #274 — perf instrumentation. Called once per `sphere.payments.receive()`
    // and once per `ensureSync(sphere, 'full')`. Per perf-engineer, the CLI runs
    // ensureSync at the start of every command — making this span the cheapest
    // diagnostic for cross-process replay-storm volume.
    const __span = logger.time('transport:nostr', 'fetchPendingEvents', {});
    const nostrPubkey = this.keyManager.getPublicKeyHex();

    const walletFilter = new Filter();
    walletFilter.kinds = [
      EVENT_KINDS.DIRECT_MESSAGE,
      EVENT_KINDS.TOKEN_TRANSFER,
      EVENT_KINDS.PAYMENT_REQUEST,
      EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
      EventKinds.GIFT_WRAP, // NIP-17 gift-wrapped DMs (swap proposals, invoice receipts, etc.)
    ];
    walletFilter['#p'] = [nostrPubkey];
    // NIP-17 gift wraps have randomized created_at (±172800 s).  Extend the
    // catch-up window by the full randomization range so events sent recently
    // but timestamped far in the past are not missed.
    walletFilter.since = Math.floor(Date.now() / 1000) - 86400 - 172800;

    // Capture client reference after the guard to avoid a null-deref race:
    // a concurrent disconnect() can set this.nostrClient = null between the
    // isConnected() check above and the subscribe() call below.
    const client = this.nostrClient;

    // Collect events first, then process after EOSE
    const events: NostrEvent[] = [];
    // Declared outside the Promise so it's available for cleanup after resolve.
    let subId: string | undefined;

    await new Promise<void>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let settled = false;

      // settle() only resolves the Promise — unsubscribe happens AFTER the Promise
      // resolves (below), where subId is guaranteed to be the real subscription ID.
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };

      try {
        subId = client.subscribe(walletFilter, {
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
    __span.mark('eose', { eventCount: events.length });

    // Process collected events sequentially (dedup skips already-processed ones)
    const __dispatchT0 = Date.now();
    for (const event of events) {
      await this.handleEvent(event);
    }
    __span.end({
      eventCount: events.length,
      dispatchDurationMs: Date.now() - __dispatchT0,
    });
  }

  /**
   * Default upper bound for `queryEvents` REQ→EOSE wait. Was 15 s historically
   * but real-network testnet runs (Phase 9 e2e) repeatedly observed the relay
   * fluctuating between healthy (<200 ms EOSE) and degraded (10-25 s EOSE,
   * sometimes never EOSE). 60 s pushes the timeout past every degraded
   * sample we've captured while still failing fast on real "no such event"
   * queries. Override per call via the second argument.
   */
  private static readonly DEFAULT_QUERY_TIMEOUT_MS = 60000;

  private async queryEvents(
    filterObj: NostrFilter,
    timeoutMs: number = NostrTransportProvider.DEFAULT_QUERY_TIMEOUT_MS,
  ): Promise<NostrEvent[]> {
    if (!this.nostrClient || !this.nostrClient.isConnected()) {
      throw new SphereError('No connected relays', 'TRANSPORT_ERROR');
    }

    // Capture client reference after the guard — same disconnect() race as fetchPendingEvents.
    const client = this.nostrClient;

    const events: NostrEvent[] = [];
    const filter = new Filter(filterObj);
    // Declared outside the Promise so unsubscription can happen after resolve(),
    // where subId is guaranteed to be the real subscription ID (not in TDZ).
    let subId: string | undefined;

    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (subId) {
          try { client.unsubscribe(subId); } catch { /* disconnected */ }
        }
        logger.warn('Nostr', `queryEvents timed out after ${timeoutMs}ms, returning ${events.length} event(s)`, { kinds: filterObj.kinds, limit: filterObj.limit });
        resolve(events);
      }, timeoutMs);

      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (subId) { try { client.unsubscribe(subId); } catch { /* disconnected */ } }
        resolve(events);
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
      } catch {
        clearTimeout(timeout);
        resolve(events);
        return;
      }

    });
  }

  // ===========================================================================
  // Private: Subscriptions
  // ===========================================================================

  // Track subscription IDs for cleanup
  private walletSubscriptionId: string | null = null;
  private chatSubscriptionId: string | null = null;

  // Chat EOSE handlers — fired once when relay finishes delivering stored DMs
  private chatEoseHandlers: Array<() => void> = [];
  private chatEoseFired = false;

  // ---------------------------------------------------------------------------
  // Issue #423 — handler-readiness gate (public + helpers)
  // ---------------------------------------------------------------------------

  /**
   * Issue #423 — explicitly arm subscriptions. Call this AFTER all message
   * handlers (`onTokenTransfer`, `onMessage`, `onPaymentRequest`, etc.) have
   * been registered on this provider, so relay events arrive at fully-wired
   * handlers and do NOT fall into the defensive `pendingTransfers` buffer
   * that triggers the "[AT-LEAST-ONCE] not durable" warn.
   *
   * Idempotent: subsequent calls are no-ops once subscriptions are armed.
   * Safe to call before `connect()` — the arming state is recorded and the
   * next `connect()` will open the subscription as part of its normal flow.
   * Safe to call multiple times during a single session: re-arming is a no-op.
   *
   * Sphere bootstrap calls this from `initializeModules()` after every
   * module's `initialize()` has run (handlers attached). The mux path does
   * NOT need to call this — `suppressSubscriptions()` skips the auto-arm
   * because the outer provider's subscription is irrelevant when the mux
   * owns event routing.
   *
   * The gate is sticky: armed → stays armed for the lifetime of this
   * instance. Reconnects re-subscribe automatically once armed. A subsequent
   * call to `disconnect()` resets the arming state so a fresh `connect()`
   * cycle goes through the gate again — this matches the existing contract
   * where `disconnect()` tears down all session state.
   */
  async armSubscriptions(): Promise<void> {
    if (this.subscriptionsArmed) return;
    this.subscriptionsArmed = true;
    logger.debug('Nostr', '[#423] Subscriptions armed — opening relay subscription if connected');
    await this.maybeSubscribe();
  }

  /** Issue #423 — for tests and operator inspection. */
  isSubscriptionsArmed(): boolean {
    return this.subscriptionsArmed;
  }

  /**
   * Issue #423 — gated wrapper around `subscribeToEvents()`. Called from
   * connect()/setIdentity()/reconnect/armSubscriptions/on*-handler-register.
   *
   * Behavior:
   *   - If suppressed (mux took over): no-op (mux owns subscriptions).
   *   - If armed: proceed to `subscribeToEvents()` — opens the relay
   *     subscription on the underlying NostrClient.
   *   - Otherwise: record `pendingArm = true` and bail. The next call from
   *     a gate-opening surface (armSubscriptions / on*-register) will
   *     proceed.
   */
  private async maybeSubscribe(): Promise<void> {
    if (this._subscriptionsSuppressed) return;
    if (!this.subscriptionsArmed) {
      this.pendingArm = true;
      logger.debug(
        'Nostr',
        '[#423] subscribe deferred — handler-readiness gate closed (waiting for armSubscriptions or first handler)',
      );
      return;
    }
    this.pendingArm = false;
    await this.subscribeToEvents();
  }

  /**
   * Issue #423 — auto-arm on first handler registration. Called from each
   * `on*` registration method as a backward-compat fallback for consumers
   * that do not know about the explicit `armSubscriptions()` API.
   *
   * No-op once already armed or suppressed. Fire-and-forget: the underlying
   * subscribe is async but `on*` methods are synchronous in their existing
   * contract, so we don't await here.
   */
  private autoArmOnHandlerRegistration(): void {
    if (this.subscriptionsArmed) return;
    if (this._subscriptionsSuppressed) return;
    this.subscriptionsArmed = true;
    logger.debug(
      'Nostr',
      '[#423] Subscriptions auto-armed on first handler registration',
    );
    this.maybeSubscribe().catch((err) => {
      logger.error('Nostr', '[#423] auto-arm subscribe failed:', err);
    });
  }

  private async subscribeToEvents(): Promise<void> {
    logger.debug('Nostr', 'subscribeToEvents called, identity:', !!this.identity, 'keyManager:', !!this.keyManager, 'nostrClient:', !!this.nostrClient);
    if (this._subscriptionsSuppressed) {
      logger.debug('Nostr', 'subscribeToEvents: suppressed — mux handles event routing');
      return;
    }
    if (!this.identity || !this.keyManager || !this.nostrClient) {
      logger.debug('Nostr', 'subscribeToEvents: skipped - no identity, keyManager, or nostrClient');
      return;
    }

    // Unsubscribe from previous subscriptions if any
    if (this.walletSubscriptionId) {
      this.nostrClient.unsubscribe(this.walletSubscriptionId);
      this.walletSubscriptionId = null;
    }
    if (this.chatSubscriptionId) {
      this.nostrClient.unsubscribe(this.chatSubscriptionId);
      this.chatSubscriptionId = null;
    }
    if (this.mainSubscriptionId) {
      this.nostrClient.unsubscribe(this.mainSubscriptionId);
      this.mainSubscriptionId = null;
    }

    // Use 32-byte Nostr pubkey (x-coordinate only), not 33-byte compressed key
    const nostrPubkey = this.keyManager.getPublicKeyHex();
    logger.debug('Nostr', 'Subscribing with Nostr pubkey:', nostrPubkey);

    // Issue #275 — hydrate persistent dedup BEFORE the relay since-filter
    // re-delivers backlog events. Without this, the relay's EOSE burst
    // would hit the empty in-memory set, re-dispatch every event, and
    // pay the parse/adapter/addToken cost for events the previous
    // process already finalized.
    await this.hydrateProcessedDedup();

    // Determine 'since' filter from persisted last event timestamp.
    // - Existing wallet: resume from last processed event (inclusive >=, dedup handles replays)
    // - Fresh wallet / no storage: use current time (no historical replay)
    let since: number;
    if (this.storage) {
      const storageKey = `${STORAGE_KEYS_GLOBAL.LAST_WALLET_EVENT_TS}_${nostrPubkey.slice(0, 16)}`;
      try {
        const stored = await this.storage.get(storageKey);
        if (stored) {
          since = parseInt(stored, 10);
          this.lastEventTs = since; // Seed in-memory tracker from storage
          this.fallbackSince = null; // Stored value takes priority
          logger.debug('Nostr', 'Resuming from stored event timestamp:', since);
        } else if (this.fallbackSince !== null) {
          // No stored timestamp but caller provided a fallback (e.g. address creation time).
          // This ensures events sent while the address was inactive are not missed.
          since = this.fallbackSince;
          this.lastEventTs = since;
          this.fallbackSince = null; // Consume once
          logger.debug('Nostr', 'Using fallback since timestamp:', since);
        } else {
          // No stored timestamp, no fallback = fresh wallet, start from now
          since = Math.floor(Date.now() / 1000);
          logger.debug('Nostr', 'No stored timestamp, starting from now:', since);
        }
      } catch (err) {
        logger.debug('Nostr', 'Failed to read last event timestamp, falling back to now:', err);
        since = Math.floor(Date.now() / 1000);
        this.fallbackSince = null;
      }
    } else {
      // No storage adapter — fallback to last 24h (legacy behavior)
      since = Math.floor(Date.now() / 1000) - 86400;
      logger.debug('Nostr', 'No storage adapter, using 24h fallback');
    }

    // Subscribe to wallet events (token transfers, payment requests) with since filter
    const walletFilter = new Filter();
    walletFilter.kinds = [
      EVENT_KINDS.DIRECT_MESSAGE,
      EVENT_KINDS.TOKEN_TRANSFER,
      EVENT_KINDS.PAYMENT_REQUEST,
      EVENT_KINDS.PAYMENT_REQUEST_RESPONSE,
    ];
    walletFilter['#p'] = [nostrPubkey];
    walletFilter.since = since;

    this.walletSubscriptionId = this.nostrClient.subscribe(walletFilter, {
      onEvent: (event) => {
        logger.debug('Nostr', 'Received wallet event kind:', event.kind, 'id:', event.id?.slice(0, 12));
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
        logger.debug('Nostr', 'Wallet subscription ready (EOSE)');
      },
      onError: (_subId, error) => {
        logger.debug('Nostr', 'Wallet subscription error:', error);
      },
    });
    logger.debug('Nostr', 'Wallet subscription created, subId:', this.walletSubscriptionId);

    // Determine 'since' for DM (gift-wrap) subscription independently from wallet events.
    let dmSince: number;
    if (this.storage) {
      const dmStorageKey = `${STORAGE_KEYS_GLOBAL.LAST_DM_EVENT_TS}_${nostrPubkey.slice(0, 16)}`;
      try {
        const stored = await this.storage.get(dmStorageKey);
        const parsed = stored ? parseInt(stored, 10) : NaN;
        if (Number.isFinite(parsed)) {
          dmSince = parsed;
          this.lastDmEventTs = dmSince;
          this.fallbackDmSince = null; // Stored value takes priority
          logger.debug('Nostr', 'DM resuming from stored timestamp:', dmSince);
        } else if (this.fallbackDmSince !== null) {
          dmSince = this.fallbackDmSince;
          this.lastDmEventTs = dmSince;
          this.fallbackDmSince = null; // Consume once
          logger.debug('Nostr', 'DM using fallback since timestamp:', dmSince);
        } else {
          dmSince = Math.floor(Date.now() / 1000);
          logger.debug('Nostr', 'No stored DM timestamp, starting from now:', dmSince);
        }
      } catch (err) {
        if (this.fallbackDmSince !== null) {
          dmSince = this.fallbackDmSince;
          this.lastDmEventTs = dmSince;
          this.fallbackDmSince = null;
          logger.debug('Nostr', 'Storage read failed, using DM fallback since:', dmSince, err);
        } else {
          dmSince = Math.floor(Date.now() / 1000);
          logger.debug('Nostr', 'Failed to read last DM event timestamp, falling back to now:', err);
        }
      }
    } else if (this.fallbackDmSince !== null) {
      dmSince = this.fallbackDmSince;
      this.lastDmEventTs = dmSince;
      this.fallbackDmSince = null;
      logger.debug('Nostr', 'No storage adapter for DM, using fallback since:', dmSince);
    } else {
      dmSince = Math.floor(Date.now() / 1000);
      logger.debug('Nostr', 'No storage adapter for DM, starting from now:', dmSince);
    }

    const chatFilter = new Filter();
    chatFilter.kinds = [EventKinds.GIFT_WRAP];
    chatFilter['#p'] = [nostrPubkey];
    // NIP-17 gift wraps have created_at randomized ±2 days for privacy.
    // Without this offset, ~50% of messages are silently dropped by the relay
    // because their randomized timestamp lands before the `since` filter.
    // Math.max(0, ...) prevents negative timestamps when dmSince is small.
    chatFilter.since = Math.max(0, dmSince - TIMESTAMP_RANDOMIZATION);

    this.chatSubscriptionId = this.nostrClient.subscribe(chatFilter, {
      onEvent: (event) => {
        logger.debug('Nostr', 'Received chat event kind:', event.kind, 'id:', event.id?.slice(0, 12));
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
        logger.debug('Nostr', 'Chat subscription ready (EOSE)');
        if (!this.chatEoseFired) {
          this.chatEoseFired = true;
          for (const handler of this.chatEoseHandlers) {
            try { handler(); } catch { /* ignore */ }
          }
          this.chatEoseHandlers = [];
        }
      },
      onError: (_subId, error) => {
        logger.debug('Nostr', 'Chat subscription error:', error);
      },
    });
    logger.debug('Nostr', 'Chat subscription created, subId:', this.chatSubscriptionId);
  }

  private subscribeToTags(tags: string[]): void {
    if (!this.nostrClient) return;

    const key = tags.sort().join(':');
    const filter = new Filter({
      kinds: [EVENT_KINDS.BROADCAST],
      '#t': tags,
      since: Math.floor(Date.now() / 1000) - 3600, // Last hour
    });

    const subId = this.nostrClient.subscribe(filter, {
      onEvent: (event) => {
        this.handleBroadcast({
          id: event.id,
          kind: event.kind,
          content: event.content,
          tags: event.tags,
          pubkey: event.pubkey,
          created_at: event.created_at,
          sig: event.sig,
        });
      },
    });

    this.broadcastSubscriptions.set(key, subId);
  }

  // ===========================================================================
  // Private: Encryption
  // ===========================================================================

  private async decryptContent(content: string, senderPubkey: string): Promise<string> {
    if (!this.keyManager) throw new SphereError('KeyManager not initialized', 'NOT_INITIALIZED');

    // Decrypt content using NIP-04 (using hex variant for string keys)
    const decrypted = await NIP04.decryptHex(
      content,
      this.keyManager.getPrivateKeyHex(),
      senderPubkey
    );

    // Strip known prefixes for compatibility with nostr-js-sdk
    return this.stripContentPrefix(decrypted);
  }

  /**
   * Strip known content prefixes (nostr-js-sdk compatibility)
   * Handles: payment_request:, token_transfer:, etc.
   */
  private stripContentPrefix(content: string): string {
    const prefixes = [
      'payment_request:',
      'token_transfer:',
      'payment_response:',
    ];

    for (const prefix of prefixes) {
      if (content.startsWith(prefix)) {
        return content.slice(prefix.length);
      }
    }

    return content;
  }

  // ===========================================================================
  // Private: Helpers
  // ===========================================================================

  private ensureConnected(): void {
    if (!this.isConnected()) {
      throw new SphereError('NostrTransportProvider not connected', 'TRANSPORT_ERROR');
    }
  }

  /**
   * Async version of ensureConnected — reconnects if the original transport
   * lost its WebSocket while subscriptions are suppressed (mux handles events).
   * Used by resolve methods which are always async.
   */
  private async ensureConnectedForResolve(): Promise<void> {
    if (this.isConnected()) return;

    // When mux is active, the original transport can lose its idle WebSocket.
    // Reconnect transparently so resolve operations still work.
    if (this._subscriptionsSuppressed && this.nostrClient) {
      logger.debug('Nostr', 'Suppressed transport disconnected — reconnecting for resolve');
      try {
        await Promise.race([
          this.nostrClient.connect(...this.config.relays),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('reconnect timeout')), 5000)
          ),
        ]);
        if (this.nostrClient.isConnected()) {
          this.status = 'connected';
          return;
        }
      } catch {
        // Fall through to throw
      }
    }

    throw new SphereError('NostrTransportProvider not connected', 'TRANSPORT_ERROR');
  }

  private ensureReady(): void {
    this.ensureConnected();
    if (!this.identity) {
      throw new SphereError('Identity not set', 'NOT_INITIALIZED');
    }
  }

  private emitEvent(event: TransportEvent): void {
    for (const callback of this.eventCallbacks) {
      try {
        callback(event);
      } catch (error) {
        logger.debug('Nostr', 'Event callback error:', error);
      }
    }
  }

  /**
   * Create a NIP-17 gift wrap with a custom inner rumor kind.
   * Replicates the three-layer NIP-59 envelope (rumor → seal → gift wrap)
   * because NIP17.createGiftWrap hardcodes kind 14 for the inner rumor.
   */
  private createCustomKindGiftWrap(recipientPubkeyHex: string, content: string, rumorKind: number): NostrEventClass {
    return NostrTransportProvider.createCustomKindGiftWrap(this.keyManager!, recipientPubkeyHex, content, rumorKind);
  }

  /**
   * Create a NIP-17 gift wrap with a custom rumor kind.
   * Shared between NostrTransportProvider and MultiAddressTransportMux.
   */
  static createCustomKindGiftWrap(keyManager: NostrKeyManager, recipientPubkeyHex: string, content: string, rumorKind: number): NostrEventClass {
    const senderPubkey = keyManager.getPublicKeyHex();
    const now = Math.floor(Date.now() / 1000);

    // 1. Create Rumor (unsigned inner event with custom kind)
    const rumorTags: string[][] = [['p', recipientPubkeyHex]];
    const rumorSerialized = JSON.stringify([0, senderPubkey, now, rumorKind, rumorTags, content]);
    const rumorId = bytesToHex(sha256Noble(new TextEncoder().encode(rumorSerialized)));
    const rumor = { id: rumorId, pubkey: senderPubkey, created_at: now, kind: rumorKind, tags: rumorTags, content };

    // 2. Create Seal (kind 13, signed by sender, encrypts rumor)
    const recipientPubkeyBytes = hexToBytes(recipientPubkeyHex);
    const encryptedRumor = NIP44.encrypt(JSON.stringify(rumor), keyManager.getPrivateKey(), recipientPubkeyBytes);
    const sealTimestamp = now + Math.floor(Math.random() * 2 * TIMESTAMP_RANDOMIZATION) - TIMESTAMP_RANDOMIZATION;
    const seal = NostrEventClass.create(keyManager, {
      kind: EventKinds.SEAL,
      tags: [],
      content: encryptedRumor,
      created_at: sealTimestamp,
    });

    // 3. Create Gift Wrap (kind 1059, signed by ephemeral key, encrypts seal)
    const ephemeralKeys = NostrKeyManager.generate();
    const encryptedSeal = NIP44.encrypt(JSON.stringify(seal.toJSON()), ephemeralKeys.getPrivateKey(), recipientPubkeyBytes);
    const wrapTimestamp = now + Math.floor(Math.random() * 2 * TIMESTAMP_RANDOMIZATION) - TIMESTAMP_RANDOMIZATION;
    const giftWrap = NostrEventClass.create(ephemeralKeys, {
      kind: EventKinds.GIFT_WRAP,
      tags: [['p', recipientPubkeyHex]],
      content: encryptedSeal,
      created_at: wrapTimestamp,
    });
    ephemeralKeys.clear();

    return giftWrap;
  }

}

// =============================================================================
// Types
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

interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  '#p'?: string[];
  '#t'?: string[];
  '#d'?: string[];
  since?: number;
  until?: number;
  limit?: number;
}
