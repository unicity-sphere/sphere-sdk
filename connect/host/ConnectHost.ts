/**
 * ConnectHost — Wallet side of Sphere Connect.
 *
 * Wraps a Sphere instance and exposes its API through a ConnectTransport.
 * Handles permission checking, rate limiting, session management,
 * and delegates intents to the wallet app via callbacks.
 */

import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';
import type { SphereEventType, SphereEventHandler } from '../../types';
import type {
  ConnectTransport,
  ConnectSession,
  ConnectHostConfig,
  WalletState,
  LockedRequestContext,
  IntentContext,
} from '../types';
import type {
  SphereConnectMessage,
  SphereRpcRequest,
  SphereIntentRequest,
  SphereHandshake,
  PublicIdentity,
  SphereRpcError,
  NetworkInfo,
  WalletLockedData,
  WalletLockedPayload,
  WalletUnlockedPayload,
  WalletDisconnectedPayload,
} from '../protocol';
import {
  SPHERE_CONNECT_NAMESPACE,
  SPHERE_CONNECT_VERSION,
  RPC_METHODS,
  ERROR_CODES,
  WALLET_EVENTS,
  createRequestId,
  isAutoPushedEvent,
} from '../protocol';
import { checkCompatibility } from '../compatibility';
import { SDK_VERSION } from '../version';
import {
  DEFAULT_PERMISSIONS,
  hasMethodPermission,
  hasIntentPermission,
} from '../permissions';
import type { PermissionScope } from '../permissions';
import type { SphereInstance, ConnectDirectMessage } from './SphereInstance';
import {
  assertWalletTransition,
  gate,
  WALLET_LOCKED_MESSAGE,
  INTERNAL_ERROR_MESSAGE,
  INTENT_UNKNOWN_MESSAGE,
  NOT_CONNECTED_MESSAGE,
} from './host-state';
import type { WalletSnapshot } from './WalletSnapshot';
import { EMPTY_WALLET_SNAPSHOT, buildWalletSnapshot } from './WalletSnapshot';
import { InFlightRegistry } from './InFlightRegistry';
import type { InFlightEntry } from './InFlightRegistry';

const DEFAULT_SESSION_TTL_MS = 86400000; // 24 hours
const DEFAULT_MAX_RPS = 20;
const DEFAULT_REQUEST_DEADLINE_MS = 25000;
// LONGER than ConnectClient's own DEFAULT_INTENT_TIMEOUT (120 s). The host must never be the
// first to give up on a delegated intent: whoever answers first defines the outcome for the
// dApp, and the host cannot know whether the wallet has already submitted the transfer. With
// the client timing out first, the dApp learns "outcome unknown" from its own clock instead of
// being told, authoritatively and falsely, that nothing happened.
const DEFAULT_INTENT_DEADLINE_MS = 180000;
const DEFAULT_HANDSHAKE_DEADLINE_MS = 120000;

/** Resolve `promise`, or `fallback()` after `ms`. Used ONLY for onConnectionRequest, which
 *  has no id and therefore cannot live in InFlightRegistry. A rejection still propagates,
 *  so handleHandshake's own error handling is unchanged. */
function withDeadline<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback()), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export class ConnectHost {
  /** Null whenever _walletState is 'locked' or 'unavailable' (invariant B). */
  private sphere: SphereInstance | null;

  /** The wallet-binding axis. Underscored because `walletState` is the public getter.
   *  ORTHOGONAL to `session` — a locked wallet keeps its session, a live wallet may have
   *  none. Written only by the WALLET (setLocked / setUnavailable / updateSphere / destroy);
   *  `session` is written by the dApp handshake, sphere_disconnect and expiry. */
  private _walletState: WalletState;

  /** Immutable public facts about the current binding. Refreshed on every bind
   *  (constructor, updateSphere); FROZEN by setLocked(); EMPTY after setUnavailable() and
   *  destroy(). Never read from Sphere while locked — that is a property of the types
   *  here, not of code review. */
  private snapshot: WalletSnapshot;

  /** Subscription KEYS captured by setLocked() BEFORE the unsub closures are detached.
   *  Sphere.destroy() kills those closures, so the keys are the only recoverable
   *  information. Excludes 'identity:changed' (autoSubscribeIdentityChanged re-arms it).
   *  A Set, not an array: handleSubscribe may be called twice for the same key while
   *  locked. */
  private suspendedSubscriptions: Set<string> = new Set();

  /** Every accepted id, with its own host-side timer. The single convergence point for
   *  lock / revoke / unavailable / destroy / deadline. */
  private readonly inFlight: InFlightRegistry;

  private readonly transport: ConnectTransport;
  private readonly config: ConnectHostConfig;

  private session: ConnectSession | null = null;
  private grantedPermissions: Set<string> = new Set();

  // Event subscription management
  private eventSubscriptions: Map<string, () => void> = new Map(); // eventName → unsub

  // Intent auto-approve: action → handler that bypasses wallet UI
  private autoApprovedIntents = new Map<
    string,
    (action: string, params: Record<string, unknown>, session: ConnectSession) => Promise<{ result?: unknown; error?: { code: number; message: string } }>
  >();

  // Rate limiting
  private rateLimitCounter = 0;
  private rateLimitResetAt = 0;

  private unsubscribeTransport: (() => void) | null = null;

  constructor(config: ConnectHostConfig) {
    this.transport = config.transport;
    this.config = config;

    this._walletState = config.initialWalletState ?? 'live';
    this.sphere = (config.sphere ?? null) as SphereInstance | null;
    if (this._walletState === 'live' && !this.sphere) {
      // Fail LOUD but soft: a throw here breaks the wallet's React mount.
      logger.warn(
        'ConnectHost',
        'Constructed live with sphere === null; coercing to unavailable. ' +
          'Pass initialWalletState: "locked" when the wallet is locked at construction time.',
      );
      this._walletState = 'unavailable';
    }
    if (this._walletState !== 'live') this.sphere = null; // invariant B, unconditionally
    this.snapshot = buildWalletSnapshot(this.sphere);      // EMPTY_WALLET_SNAPSHOT when null

    this.inFlight = new InFlightRegistry({ onExpire: (e) => this.settleExpired(e) });

    this.unsubscribeTransport = this.transport.onMessage(this.handleMessage.bind(this));
  }

  /** The wallet-binding axis. Orthogonal to {@link getSession}. Read-only —
   *  transitions go through setLocked() / setUnavailable() / updateSphere(). */
  get walletState(): WalletState {
    return this._walletState;
  }

  /** Both axes in one read, for UI that must render "connected AND locked".
   *  Required by the wallet's ConnectPage, which today renders a green pulsing
   *  "Connected to {dapp}" with no regard for lock state. */
  getState(): { readonly walletState: WalletState; readonly session: ConnectSession | null } {
    return { walletState: this._walletState, session: this.session };
  }

  /** Get current active session */
  getSession(): ConnectSession | null {
    return this.session;
  }

  /** Register an auto-approve handler for an intent action (session-scoped). */
  setIntentAutoApprove(
    action: string,
    handler: (
      action: string,
      params: Record<string, unknown>,
      session: ConnectSession,
    ) => Promise<{ result?: unknown; error?: { code: number; message: string } }>,
  ): void {
    this.autoApprovedIntents.set(action, handler);
  }

  /** Remove auto-approve for an intent action. */
  clearIntentAutoApprove(action: string): void {
    this.autoApprovedIntents.delete(action);
  }

  /**
   * Bind a (new) Sphere instance. This is BOTH the re-arm path after setLocked() /
   * setUnavailable() AND the existing address-switch path in a live wallet.
   *
   * From 'live' (address switch): today's behaviour, unchanged — re-arm identity:changed,
   *   push identity:changed. NO identity comparison: an address switch is legal.
   *
   * On the 'locked' -> 'live' edge, in this order:
   *   1. compare snapshot.identity?.chainPubkey with the new Sphere's chainPubkey.
   *      MISMATCH => revokeSession() (which pushes wallet:disconnected) and RETURN.
   *      Never wallet:unlocked. This is the "Forgot password -> restore recovery phrase
   *      installed a different seed behind an origin-keyed approval" guard.
   *   2. session.expiresAt passed => revokeSession() and RETURN. A wallet:unlocked into a
   *      dead session would make the dApp's next request answer SESSION_EXPIRED 4004.
   *   3. rebind, refresh the snapshot, go live, re-arm identity:changed, replay every
   *      suspended sphere_subscribe key, and ONLY THEN push wallet:unlocked with the
   *      CURRENT identity. Re-arm BEFORE push, so a dApp reacting synchronously cannot
   *      race its own event streams.
   *
   * From 'unavailable' -> 'live': rebind + refresh the snapshot, no identity check
   *   (nothing was bound to compare against) and no event (the session is already null).
   */
  updateSphere(newSphere: unknown): void {
    const wasLocked = this._walletState === 'locked';
    const next = (newSphere ?? null) as SphereInstance | null;

    // `null` is explicitly anticipated by the coalesce above, and committing 'live' without a
    // Sphere is unrepresentable: every query would dereference null and answer -32603 forever,
    // never 4009, while the client keeps reporting walletLocked with nothing able to clear it.
    // Route it to the verb that actually means "there is no Sphere".
    if (!next) {
      if (this._walletState === 'locked') {
        // Stay locked. The dApp is waiting for a real unlock; a spurious 'unavailable' would
        // revoke a session that a genuine unlock could still have served.
        logger.warn('ConnectHost', 'updateSphere(null) while locked — staying locked');
        return;
      }
      logger.warn('ConnectHost', 'updateSphere(null) — treating as a non-lock loss of Sphere');
      this.setUnavailable();
      return;
    }

    if (this._walletState === 'live') {
      // Address switch on a live host — today's behaviour, verbatim.
      this.sphere = next;
      this.snapshot = buildWalletSnapshot(next);
      const existing = this.eventSubscriptions.get(WALLET_EVENTS.IDENTITY_CHANGED);
      if (existing) {
        existing();
        this.eventSubscriptions.delete(WALLET_EVENTS.IDENTITY_CHANGED);
      }
      if (this.session?.active) {
        this.autoSubscribeIdentityChanged();
        // Push the new identity immediately so dApp doesn't have to wait for the next event
        const identity = this.getPublicIdentity();
        if (identity) {
          this.pushClientEvent(WALLET_EVENTS.IDENTITY_CHANGED, identity);
        }
      }
      return;
    }

    // 1. Lock-edge identity guard — ONLY on locked -> live. From 'unavailable' there is
    //    nothing to compare against.
    if (wasLocked && this.session?.active) {
      // FAIL CLOSED. `before && after &&` used to no-op the whole guard whenever either side
      // was absent — and an absent `before` is exactly what a wallet manufactures by calling
      // sphere.destroy() before setLocked(), an ordering the docs ask for but nothing enforces.
      // An unknown identity on either side is a mismatch: it is not evidence of sameness.
      const before = this.snapshot.identity?.chainPubkey ?? null;
      const after = next.identity?.chainPubkey ?? null;
      // A NETWORK change is equally unrecoverable and was not checked at all. On main a lock
      // revoked unconditionally, so a re-handshake ran checkCompatibility and answered 4008;
      // preserving the session across a lock skipped that gate, leaving the dApp served
      // balances from a chain it never agreed to while still reporting the old network.
      const netBefore = this.snapshot.networkId ?? null;
      const netAfter = next.networkId ?? null;
      if (before !== after || netBefore !== netAfter) {
        logger.warn(
          'ConnectHost',
          `Wallet behind the lock screen is not the one this session was approved for — revoking instead of unlocking (origin=${this.config.origin ?? 'unverified'})`,
        );
        assertWalletTransition(this._walletState, 'live');
        this._walletState = 'live';
        this.sphere = next;
        this.snapshot = buildWalletSnapshot(next);
        this.revokeSession();   // pushes wallet:disconnected, settles in flight with 4001
        return;
      }

      // 2. Expired while locked. The TTL is 24 h by default and expiresAt does not refresh.
      if (this.session.expiresAt > 0 && Date.now() > this.session.expiresAt) {
        logger.warn(
          'ConnectHost',
          `Session expired while locked — re-handshake required (origin=${this.config.origin ?? 'unverified'})`,
        );
        assertWalletTransition(this._walletState, 'live');
        this._walletState = 'live';
        this.sphere = next;
        this.snapshot = buildWalletSnapshot(next);
        this.revokeSession();
        return;
      }
    }

    // 3. Rebind and go live. _walletState is set BEFORE the replay, because
    //    handleSubscribe() branches on it and would otherwise put every key straight back
    //    into suspendedSubscriptions and arm nothing.
    assertWalletTransition(this._walletState, 'live');
    this.sphere = next;
    this.snapshot = buildWalletSnapshot(next);
    this._walletState = 'live';

    if (!this.session?.active) {
      // Nothing to re-arm and nothing to announce.
      this.suspendedSubscriptions.clear();
      return;
    }

    this.autoSubscribeIdentityChanged();

    const suspended = [...this.suspendedSubscriptions];
    this.suspendedSubscriptions.clear();
    for (const eventName of suspended) {
      try {
        this.handleSubscribe(eventName);
      } catch (err) {
        logger.warn('ConnectHost', `Re-subscribe failed after unlock: ${eventName}`, err);
      }
    }

    logger.debug(
      'ConnectHost',
      `Wallet unlocked — re-armed ${suspended.length} subscription(s) (origin=${this.config.origin ?? 'unverified'})`,
    );

    this.pushClientEvent(WALLET_EVENTS.UNLOCKED, {
      identity: this.getPublicIdentity(),
    } satisfies WalletUnlockedPayload);

    // AND identity:changed, which main pushed on every unlock and which the Connect 2.0 docs
    // named as the ONLY unlock signal. checkCompatibility gates on the MAJOR alone, so every
    // already-shipped 2.0 dApp connects to a 2.1 wallet happily — and then, without this, sits
    // showing "wallet locked" for the rest of the page's life, because wallet:unlocked is a
    // name it has never heard of. Idempotent for a 2.1 client: it has already written the same
    // identity from the payload above, and its IDENTITY_CHANGED branch just rewrites it.
    const identity = this.getPublicIdentity();
    if (identity) this.pushClientEvent(WALLET_EVENTS.IDENTITY_CHANGED, identity);
  }

  /**
   * The wallet locked (manual lock, idle auto-lock, cross-tab broadcast, cold start).
   * The session is PRESERVED — a lock is a state, not a teardown. Every request outside
   * the locked allow-list is answered WALLET_LOCKED (4009) until updateSphere().
   *
   * Idempotent: a second call is a no-op and pushes nothing. Required, because
   * SphereProvider.lock(), ConnectPage's `sphere → null` effect and broadcastLock()'s
   * same-tab loopback can all fire it for one user action.
   *
   * ORDERING CONTRACT: call this BEFORE sphere.destroy(). The host drops its Sphere
   * reference here; destroying first leaves in-flight requests reading a dead instance
   * (-32603, or `undefined` returned AS SUCCESS from sphere_getIdentity).
   */
  setLocked(): void {
    if (this._walletState === 'locked') return;
    assertWalletTransition(this._walletState, 'locked');

    // Freeze BEFORE dropping. snapshot.identity?.chainPubkey IS the lock-edge identity
    // binding compared in updateSphere() — there is no separate boundIdentity field.
    this.snapshot = buildWalletSnapshot(this.sphere);
    this._walletState = 'locked';
    logger.debug(
      'ConnectHost',
      `Wallet locked — session preserved (origin=${this.config.origin ?? 'unverified'}, session=${this.session?.id ?? 'none'})`,
    );

    if (this.session?.active) {
      this.pushClientEvent(WALLET_EVENTS.LOCKED, {} as WalletLockedPayload);
    }

    // Snapshot-then-detach. cleanupEventSubscriptions() ends in .clear() and the Map holds
    // eventName → closure; Sphere.destroy() kills those closures, so the KEYS are the only
    // recoverable information. Exclude identity:changed — autoSubscribeIdentityChanged()
    // re-arms that one itself.
    for (const key of this.eventSubscriptions.keys()) {
      if (key === WALLET_EVENTS.IDENTITY_CHANGED) continue;
      this.suspendedSubscriptions.add(key);
    }
    this.cleanupEventSubscriptions();

    // Today only revokeSession() clears these. Under session-preserving semantics an
    // auto-approved intent would otherwise survive a lock and execute unattended after
    // the unlock.
    this.autoApprovedIntents.clear();

    this.settleInFlight(ERROR_CODES.WALLET_LOCKED, WALLET_LOCKED_MESSAGE, { reason: 'locked' });
    this.sphere = null;
  }

  /**
   * The Sphere instance is gone for a NON-LOCK reason (a generic init failure leaves
   * `sphere === null, isLocked === false` in the wallet).
   * This is a DEAD END: unlocking does not cure it, so it revokes the session and pushes
   * wallet:disconnected rather than promising an unlock that cannot help.
   * Subsequent requests answer NOT_CONNECTED (4001); handshakes get the empty refusal
   * WITHOUT dereferencing a null Sphere.
   *
   * Idempotent. Pushes no 'wallet:unavailable' — there is no such event.
   */
  setUnavailable(): void {
    if (this._walletState === 'unavailable') return;
    assertWalletTransition(this._walletState, 'unavailable');

    this._walletState = 'unavailable';
    logger.warn(
      'ConnectHost',
      `Sphere unavailable (non-lock) — session revoked (origin=${this.config.origin ?? 'unverified'})`,
    );

    this.snapshot = EMPTY_WALLET_SNAPSHOT;   // nothing may be served from it
    this.suspendedSubscriptions.clear();
    this.revokeSession();                    // pushes wallet:disconnected, settles 4001
    this.sphere = null;
  }

  /**
   * Destroy the SESSION (logout, wallet deleted, dApp sphere_disconnect, popup
   * beforeunload, expiry, identity mismatch at unlock). Pushes wallet:disconnected BEFORE
   * tearing down, so the dApp stops believing it is connected instead of finding out at
   * its next 4001.
   *
   * This is the TEARDOWN verb. For a lock use setLocked() — a lock never destroys the
   * session. revokeSession() does NOT touch walletState: the two axes are orthogonal.
   */
  revokeSession(): void {
    if (this.session) {
      logger.debug(
        'ConnectHost',
        `Session revoked (origin=${this.config.origin ?? 'unverified'}, session=${this.session.id})`,
      );
      if (this.session.active) {
        this.pushClientEvent(WALLET_EVENTS.DISCONNECTED, {} as WalletDisconnectedPayload);
      }
      this.session.active = false;
      this.cleanupEventSubscriptions();
      this.autoApprovedIntents.clear();
      this.session = null;
      this.grantedPermissions.clear();
    }
    this.suspendedSubscriptions.clear();
    this.settleInFlight(ERROR_CODES.NOT_CONNECTED, NOT_CONNECTED_MESSAGE);
  }

  /** Destroy the host, clean up all resources. Idempotent. */
  destroy(): void {
    this.revokeSession();                       // pushes wallet:disconnected, settles 4001
    this.inFlight.destroy();                    // clear timers WITHOUT invoking onExpire
    if (this.unsubscribeTransport) {
      this.unsubscribeTransport();
      this.unsubscribeTransport = null;
    }
    this.sphere = null;
    this.snapshot = EMPTY_WALLET_SNAPSHOT;
    if (this._walletState !== 'unavailable') {
      assertWalletTransition(this._walletState, 'unavailable');
      this._walletState = 'unavailable';
    }
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private async handleMessage(msg: SphereConnectMessage): Promise<void> {
    try {
      if (msg.type === 'handshake' && msg.direction === 'request') {
        await this.handleHandshake(msg);
        return;
      }

      if (msg.type === 'request') {
        await this.handleRpcRequest(msg);
        return;
      }

      if (msg.type === 'intent') {
        await this.handleIntentRequest(msg);
        return;
      }
    } catch (error) {
      logger.warn('ConnectHost', 'Error handling message:', error);
      // A throw used to send NOTHING, so the dApp hung for its full client timeout and
      // ended with a bare Error('Query timeout: …') / Error('Intent timeout: …') /
      // Error('Connection timeout') carrying no .code.
      this.sendUnhandledError(msg, error);
    }
  }

  // ===========================================================================
  // Handshake
  // ===========================================================================

  private async handleHandshake(msg: SphereHandshake): Promise<void> {
    const dapp = msg.dapp;
    // A handshake without dapp metadata is malformed — deny silently (no session).
    // The compatibility gate and onConnectionRejected are intentionally not consulted
    // here: there is no app to gate or to surface a rejection reason for.
    if (!dapp) {
      this.sendHandshakeResponse([], undefined, undefined);
      return;
    }

    // STEP 0 — a host with no live binding AND no snapshot knows nothing about a wallet.
    // BEFORE checkCompatibility on purpose: snapshot.networkId is undefined on a
    // cold-start-locked host, so the network check (a missing network is treated as a
    // mismatch) would answer INCOMPATIBLE_NETWORK 4008 to EVERY origin — leaking
    // "a wallet lives here, network -1" with no approval, and lying about the cause.
    if (this._walletState !== 'live' && !this.snapshot.identity) {
      this.sendHandshakeResponse([], undefined, undefined);
      return;
    }

    // Rate limit. The handshake path was entirely unmetered: an unapproved origin could
    // loop handshakes and open the approval UI without bound. The refusal is today's EMPTY
    // refusal — it carries no error and reveals nothing about the wallet's state.
    if (!this.checkRateLimit()) {
      logger.warn('ConnectHost', 'Handshake rate-limited', { dapp: dapp.name });
      this.sendHandshakeResponse([], undefined, undefined);
      return;
    }

    // Captured for the pre-await decisions; RE-READ after the approval prompt below, because a
    // human-time await gives the wallet room to lock, unlock or log out underneath us.
    const stateAtPrompt = this._walletState;
    let locked = stateAtPrompt === 'locked';

    // Lock gate for the handshake kind. 'unavailable' refuses here WITHOUT dereferencing a
    // null Sphere — which is the whole reason the state exists separately.
    const handshakeDecision = gate(this._walletState, !!this.session?.active, 'handshake', 'handshake');
    if (handshakeDecision.kind === 'refuse') {
      this.sendHandshakeResponse([], undefined, undefined);
      return;
    }

    // Compatibility gate — runs BEFORE resume and BEFORE onConnectionRequest, so an
    // incompatible/old client cannot slip through on a stale sessionId.
    const result = checkCompatibility({
      clientProtocol: msg.v,
      walletProtocol: SPHERE_CONNECT_VERSION,
      clientNetwork: msg.network,
      walletNetworkId: this.snapshot.networkId ?? -1,
      minMinor: this.config.minMinorVersion,
      clientSdkVersion: msg.sdkVersion,
      minSdkVersion: this.config.minSdkVersion,
    });
    if (!result.ok) {
      logger.warn('ConnectHost', 'Rejected handshake', {
        dapp: dapp.name,
        reason: (result.error.data as { reason?: string } | undefined)?.reason,
        clientProtocol: msg.v,
        walletProtocol: SPHERE_CONNECT_VERSION,
        clientNetwork: msg.network ?? null,
        walletNetwork: this.snapshot.networkId ?? null,
      });
      this.config.onConnectionRejected?.(dapp, result.error, !!msg.silent);
      this.sendHandshakeResponse([], undefined, undefined, result.error, msg.v);
      return;
    }

    const clientInfo = { protocolVersion: msg.v, network: msg.network, sdkVersion: msg.sdkVersion };

    // Session resumption: if the client presents a valid existing sessionId,
    // skip the approval popup and restore the session without user interaction.
    // A resume DURING A LOCK succeeds and carries locked: true — a reloaded dApp is the
    // most common entry into this feature, and refusing it would leave that dApp with no
    // channel at all (it is not subscribed, so it would never receive wallet:unlocked).
    if (msg.sessionId && this.session?.active && this.session.id === msg.sessionId) {
      const identity = locked ? this.snapshotIdentity() : this.getPublicIdentity();
      this.sendHandshakeResponse(
        [...this.grantedPermissions],
        this.session.id,
        identity,
        undefined,
        undefined,
        undefined,
        locked ? true : undefined,
      );
      if (locked) {
        this.pushClientEvent(WALLET_EVENTS.LOCKED, {} as WalletLockedPayload);
        this.notifyLockedRequest('handshake', 'handshake');
      }
      return;
    }

    const requestedPermissions = msg.permissions as PermissionScope[];

    // FORCED SILENT while locked: the wallet's existing `if (silent) return { approved:
    // false }` branch refuses an unapproved origin with NO UI, and a previously approved
    // origin is approved from persisted state. No dApp request may ever raise a credential
    // surface, so a locked handshake must never be able to open one.
    const silent = msg.silent === true || locked;

    const { approved, grantedPermissions } = await withDeadline(
      Promise.resolve(
        this.config.onConnectionRequest(dapp, requestedPermissions, silent, clientInfo),
      ),
      this.config.handshakeDeadlineMs ?? DEFAULT_HANDSHAKE_DEADLINE_MS,
      () => {
        logger.warn('ConnectHost', 'Connection approval prompt timed out', { dapp: dapp.name });
        return { approved: false, grantedPermissions: [] as PermissionScope[] };
      },
    );

    // `locked` was read BEFORE a human-time await. Re-read the axis now, because the wallet can
    // have moved under us while the modal was open — an idle auto-lock, a cross-tab lock, a
    // logout, or an unlock.
    //
    // Getting this wrong in either direction is bad. Landing in 'locked' or 'unavailable' used
    // to mint an ACTIVE session on a non-live host while telling the dApp it was rejected: the
    // wallet then believes an origin is connected that has forgotten it exists, and under
    // 'unavailable' the gate refuses sphere_disconnect too, so that session is unclearable for
    // its whole TTL and onDisconnect never revokes the persisted origin approval. Landing in
    // 'live' (an unlock during the prompt) used to leave the dApp permanently walletLocked,
    // because the unlock edge had no session to notify at the time it fired.
    const stateAfterPrompt = this._walletState;
    if (stateAfterPrompt !== 'live' && stateAfterPrompt !== stateAtPrompt) {
      logger.warn(
        'ConnectHost',
        `Wallet left 'live' while the approval prompt was open — refusing the handshake instead of minting a session (state=${stateAfterPrompt}, origin=${this.config.origin ?? 'unverified'})`,
      );
      this.sendHandshakeResponse([], undefined, undefined);
      return;
    }
    // Recompute so the response's `locked` flag and the trailing push describe NOW, not then.
    locked = stateAfterPrompt !== 'live';

    if (!approved) {
      // Deliberately NO notifyLockedRequest here. This origin was DENIED — it holds no
      // approval, so there is nothing for the user to unlock *for*, and counting it would put
      // an unvetted name in the wallet's own chrome and leak the lock to it. The notify stays
      // on the resume path and the approved path, where the origin demonstrably holds one.
      this.sendHandshakeResponse([], undefined, undefined);
      return;
    }

    // Create session
    const sessionId = createRequestId();
    const allPermissions = [...new Set([...DEFAULT_PERMISSIONS, ...grantedPermissions])];
    const ttl = this.config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;

    this.session = {
      id: sessionId,
      dapp,
      permissions: allPermissions,
      createdAt: Date.now(),
      expiresAt: ttl > 0 ? Date.now() + ttl : 0,
      active: true,
    };
    this.grantedPermissions = new Set(allPermissions);

    // Auto-push identity:changed to dApp whenever the wallet switches address.
    // MetaMask pattern: no sphere_subscribe needed — host pushes it unconditionally.
    // SKIPPED while locked: there is no Sphere to attach to. updateSphere() arms it on the
    // locked -> live edge, so no extra bookkeeping is needed.
    if (!locked) this.autoSubscribeIdentityChanged();

    // Build public identity — from the snapshot while locked.
    const identity = locked ? this.snapshotIdentity() : this.getPublicIdentity();

    this.sendHandshakeResponse(
      allPermissions,
      sessionId,
      identity,
      undefined,
      undefined,
      undefined,
      locked ? true : undefined,
    );
    if (locked) this.pushClientEvent(WALLET_EVENTS.LOCKED, {} as WalletLockedPayload);
  }

  // `warning` is a forward-compatible deprecation-notice slot (see SphereHandshake.warning);
  // no call site emits one yet — reserved for the deprecation-window policy.
  private sendHandshakeResponse(
    permissions: string[],
    sessionId: string | undefined,
    identity: PublicIdentity | undefined,
    error?: SphereRpcError,
    echoV?: string,
    warning?: SphereRpcError,
    locked?: boolean,
  ): void {
    const network: NetworkInfo | undefined =
      typeof this.snapshot.networkId === 'number' ? { id: this.snapshot.networkId } : undefined;
    this.transport.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: (error && echoV ? echoV : SPHERE_CONNECT_VERSION) as typeof SPHERE_CONNECT_VERSION,
      type: 'handshake',
      direction: 'response',
      permissions,
      sessionId,
      identity,
      network,
      sdkVersion: SDK_VERSION,
      error,
      warning,
      ...(locked ? { locked: true } : {}),
    });
  }

  // ===========================================================================
  // RPC Requests (query)
  // ===========================================================================

  private async handleRpcRequest(msg: SphereRpcRequest): Promise<void> {
    // 1. Session check
    if (!this.session?.active) {
      this.sendError(msg.id, ERROR_CODES.NOT_CONNECTED, NOT_CONNECTED_MESSAGE);
      return;
    }

    // 2. Session expiry — BEFORE the lock gate. A dead session must never be advertised
    //    as "retry after unlock", and the check needs no Sphere.
    if (this.session.expiresAt > 0 && Date.now() > this.session.expiresAt) {
      // Answer THIS request before revoking: revokeSession() pushes wallet:disconnected, and
      // a client that cleans up on that event would otherwise reject this id locally before
      // our own frame arrives.
      this.sendError(msg.id, ERROR_CODES.SESSION_EXPIRED, 'Session expired');
      this.revokeSession();
      return;
    }

    // 3. Rate limit — BEFORE the lock gate, because this is what bounds onLockedRequest
    //    volume. A dApp polling in a loop while locked is throttled by the existing
    //    limiter, which is why there is no second anti-spam mechanism.
    if (!this.checkRateLimit()) {
      this.sendError(msg.id, ERROR_CODES.RATE_LIMITED, 'Too many requests');
      return;
    }

    // 4. Disconnect, BEFORE the lock gate. It has to work in EVERY wallet state, and the gate
    //    does not allow that: 'unavailable' refuses every query with NOT_CONNECTED, so a
    //    session created just before Sphere went away could never be dropped — it sat active
    //    for its whole TTL (24 h by default) and onDisconnect, the only hook that revokes the
    //    persisted origin approval, never fired. Also before the permission check, because
    //    sphere_disconnect has no mapped permission. It stays AFTER the rate limiter so a
    //    disconnect flood is still throttled.
    if (msg.method === RPC_METHODS.DISCONNECT) {
      const disconnectedSession = this.session;
      // Answer BEFORE revoking, for the same reason as the expiry branch above.
      this.sendResult(msg.id, { disconnected: true });
      this.revokeSession();
      if (disconnectedSession && this.config.onDisconnect) {
        // Fire-and-forget: don't block the response
        Promise.resolve(this.config.onDisconnect(disconnectedSession)).catch((err) => logger.warn('Connect', 'onDisconnect handler error', err));
      }
      return;
    }

    // 5. Lock gate — BEFORE the permission check, because hasMethodPermission() is false
    //    for anything unmapped, so a locked unknown method would otherwise answer
    //    PERMISSION_DENIED 4002: an un-retryable code that tells the dApp its permissions
    //    are wrong.
    const decision = gate(this._walletState, true, 'query', msg.method);
    if (decision.kind === 'refuse') {
      this.sendError(msg.id, decision.error.code, decision.error.message, decision.error.data);
      if (decision.error.code === ERROR_CODES.WALLET_LOCKED) {
        logger.debug('ConnectHost', `Refused query ${msg.method} — WALLET_LOCKED 4009 (origin=${this.config.origin ?? 'unverified'})`);
        this.notifyLockedRequest('query', msg.method);
      }
      return;
    }


    // 5. Permission check
    if (!hasMethodPermission(this.grantedPermissions, msg.method)) {
      this.sendError(msg.id, ERROR_CODES.PERMISSION_DENIED, `Permission denied for ${msg.method}`);
      return;
    }

    // 6. Snapshot answer. Only sphere_getIdentity reaches this branch (host-state.ts).
    //    An absent snapshot identity REFUSES: `undefined` sent as a SUCCESS result reads
    //    to a dApp as "the wallet has no identity".
    if (decision.kind === 'serve-from-snapshot') {
      const identity = this.snapshotIdentity();
      if (!identity) {
        this.sendError(msg.id, ERROR_CODES.WALLET_LOCKED, WALLET_LOCKED_MESSAGE, { reason: 'locked' });
        this.notifyLockedRequest('query', msg.method);
        return;
      }
      this.sendResult(msg.id, identity);
      return;
    }

    // 7. Register BEFORE the first await, with the timer armed at insertion time, then
    //    execute. Every send goes through settle(), which returns null when a lock, a
    //    revoke, a destroy or the deadline already answered this id — the whole
    //    "exactly one frame per id" mechanism.
    this.inFlight.add(msg.id, 'query', this.config.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS);
    try {
      const result = await this.executeMethod(msg.method, msg.params ?? {});
      if (!this.inFlight.settle(msg.id)) return;
      this.sendResult(msg.id, result);
    } catch (error) {
      if (!this.inFlight.settle(msg.id)) return;
      // Our OWN SphereError messages are DX ('Missing required parameter: identifier',
      // 'Communications module not available') and stay. Anything else is internal JS text
      // that must not cross the trust boundary into a third-party dApp.
      // instanceof is unreliable across bundle copies — check the name too.
      const isSphereError =
        error instanceof SphereError || (error as { name?: string })?.name === 'SphereError';
      if (isSphereError) {
        const e = error as SphereError;
        this.sendError(msg.id, ERROR_CODES.INTERNAL_ERROR, e.message, { reason: e.code });
        return;
      }
      this.sendError(msg.id, ERROR_CODES.INTERNAL_ERROR, INTERNAL_ERROR_MESSAGE);
    }
  }

  // ===========================================================================
  // Intent Requests
  // ===========================================================================

  private async handleIntentRequest(msg: SphereIntentRequest): Promise<void> {
    // 1. Session check
    if (!this.session?.active) {
      this.sendIntentError(msg.id, ERROR_CODES.NOT_CONNECTED, NOT_CONNECTED_MESSAGE);
      return;
    }

    // 2. Session expiry — BEFORE the lock gate (same reason as the query path).
    if (this.session.expiresAt > 0 && Date.now() > this.session.expiresAt) {
      // Answer first — see the query path.
      this.sendIntentError(msg.id, ERROR_CODES.SESSION_EXPIRED, 'Session expired');
      this.revokeSession();
      return;
    }

    // 3. Rate limit. checkRateLimit() was called only from handleRpcRequest, so the intent
    //    path — the money path, the one that opens wallet modals — was entirely unmetered.
    if (!this.checkRateLimit()) {
      this.sendIntentError(msg.id, ERROR_CODES.RATE_LIMITED, 'Too many requests');
      return;
    }

    // 4. Lock gate. NO allow-list: every intent needs a live wallet.
    const decision = gate(this._walletState, true, 'intent', msg.action);
    if (decision.kind === 'refuse') {
      this.sendIntentError(msg.id, decision.error.code, decision.error.message, decision.error.data);
      if (decision.error.code === ERROR_CODES.WALLET_LOCKED) {
        logger.debug('ConnectHost', `Refused intent ${msg.action} — WALLET_LOCKED 4009 (origin=${this.config.origin ?? 'unverified'})`);
        this.notifyLockedRequest('intent', msg.action);
      }
      return;
    }

    // 5. Permission check
    if (!hasIntentPermission(this.grantedPermissions, msg.action)) {
      this.sendIntentError(msg.id, ERROR_CODES.PERMISSION_DENIED, `Permission denied for intent: ${msg.action}`);
      return;
    }

    // 6. Register BEFORE the first await, then delegate. The entry owns the deadline and
    //    the AbortController, so lock / revoke / unavailable / destroy / deadline all
    //    settle this id exactly once.
    const session = this.session;
    const entry = this.inFlight.add(
      msg.id,
      'intent',
      this.config.intentDeadlineMs ?? DEFAULT_INTENT_DEADLINE_MS,
    );
    const ctx: IntentContext = {
      origin: this.config.origin,
      expiresAt: entry.deadline,
      signal: entry.controller.signal,
    };

    try {
      const autoHandler = this.autoApprovedIntents.get(msg.action);
      const response = autoHandler
        ? await autoHandler(msg.action, msg.params, session)
        : await this.config.onIntent(msg.action, msg.params, session, ctx);

      if (!this.inFlight.settle(msg.id)) return;
      if (response.error) {
        this.sendIntentError(msg.id, response.error.code, response.error.message);
      } else {
        this.sendIntentResult(msg.id, response.result);
      }
    } catch (error) {
      // A throw from onIntent or from an auto-approve handler used to reach
      // handleMessage's catch, which sent NOTHING — the dApp then hung for its full
      // intentTimeout and ended with a bare Error('Intent timeout: …') carrying no .code.
      logger.warn('ConnectHost', `Intent handler threw: ${msg.action}`, error);
      if (!this.inFlight.settle(msg.id)) return;
      this.sendIntentError(msg.id, ERROR_CODES.INTERNAL_ERROR, INTERNAL_ERROR_MESSAGE);
    }
  }

  // ===========================================================================
  // Method Router
  // ===========================================================================

  private async executeMethod(method: string, params: Record<string, unknown>): Promise<unknown> {
    // Subscription bookkeeping needs NO Sphere and is allow-listed while locked
    // (host-state.ts), so it must be answered BEFORE the dereference below — otherwise a
    // locked sphere_unsubscribe dies on requireSphere() with -32603 despite the gate
    // having let it through.
    switch (method) {
      case RPC_METHODS.SUBSCRIBE:
        return this.handleSubscribe(params.event as string);
      case RPC_METHODS.UNSUBSCRIBE:
        return this.handleUnsubscribe(params.event as string);
    }

    // ONE dereference for the whole router. The gate has already proven _walletState is
    // 'live' before we get here, so this is defence in depth — and it is what makes the
    // nullable field compile without a single `!`.
    const sphere = this.requireSphere();
    switch (method) {
      case RPC_METHODS.GET_IDENTITY:
        return this.getPublicIdentity();

      case RPC_METHODS.GET_BALANCE:
        return sphere.payments.getBalance(params.coinId as string | undefined);

      case RPC_METHODS.GET_ASSETS:
        return sphere.payments.getAssets(params.coinId as string | undefined);

      case RPC_METHODS.GET_FIAT_BALANCE:
        return { fiatBalance: await sphere.payments.getFiatBalance() };

      case RPC_METHODS.GET_TOKENS:
        return this.stripTokenSdkData(
          sphere.payments.getTokens(
            params.coinId ? { coinId: params.coinId as string } : undefined,
          ),
        );

      case RPC_METHODS.GET_HISTORY:
        return sphere.payments.getHistory();

      case RPC_METHODS.RESOLVE:
        if (!params.identifier) {
          throw new SphereError('Missing required parameter: identifier', 'VALIDATION_ERROR');
        }
        return sphere.resolve(params.identifier as string);

      case RPC_METHODS.SUBSCRIBE:
        return this.handleSubscribe(params.event as string);

      case RPC_METHODS.UNSUBSCRIBE:
        return this.handleUnsubscribe(params.event as string);

      case RPC_METHODS.GET_CONVERSATIONS: {
        const comms = sphere.communications;
        if (!comms) throw new SphereError('Communications module not available', 'MODULE_NOT_AVAILABLE');
        const convos = comms.getConversations();
        const result: Array<{
          peerPubkey: string;
          peerNametag?: string;
          lastMessage: ConnectDirectMessage;
          unreadCount: number;
          messageCount: number;
        }> = [];
        // Collect conversations and track which ones need nametag resolution
        const needsResolve: Array<{ index: number; peerPubkey: string }> = [];
        for (const [peer, messages] of convos) {
          if (messages.length === 0) continue;
          const last = messages[messages.length - 1];
          // Find peer nametag from any message in the conversation
          const peerNametag =
            messages.find(m => m.senderPubkey === peer && m.senderNametag)?.senderNametag
            ?? messages.find(m => m.recipientPubkey === peer && m.recipientNametag)?.recipientNametag;
          const idx = result.length;
          result.push({
            peerPubkey: peer,
            peerNametag,
            lastMessage: last,
            unreadCount: comms.getUnreadCount(peer),
            messageCount: messages.length,
          });
          if (!peerNametag) {
            needsResolve.push({ index: idx, peerPubkey: peer });
          }
        }
        // Resolve missing nametags via transport (parallel, best-effort)
        if (needsResolve.length > 0) {
          const resolved = await Promise.all(
            needsResolve.map(({ peerPubkey }) =>
              comms.resolvePeerNametag(peerPubkey).catch((err) => { logger.debug('Connect', 'Peer Unicity ID resolution failed', err); return undefined; }),
            ),
          );
          for (let i = 0; i < needsResolve.length; i++) {
            if (resolved[i]) {
              result[needsResolve[i].index].peerNametag = resolved[i];
            }
          }
        }
        result.sort((a, b) => b.lastMessage.timestamp - a.lastMessage.timestamp);
        return result;
      }

      case RPC_METHODS.GET_MESSAGES: {
        const comms = sphere.communications;
        if (!comms) throw new SphereError('Communications module not available', 'MODULE_NOT_AVAILABLE');
        if (!params.peerPubkey) throw new SphereError('Missing required parameter: peerPubkey', 'VALIDATION_ERROR');
        return comms.getConversationPage(
          params.peerPubkey as string,
          {
            limit: params.limit as number | undefined,
            before: params.before as number | undefined,
          },
        );
      }

      case RPC_METHODS.GET_DM_UNREAD_COUNT: {
        const comms = sphere.communications;
        if (!comms) throw new SphereError('Communications module not available', 'MODULE_NOT_AVAILABLE');
        return {
          unreadCount: comms.getUnreadCount(
            params.peerPubkey as string | undefined,
          ),
        };
      }

      case RPC_METHODS.MARK_AS_READ: {
        const comms = sphere.communications;
        if (!comms) throw new SphereError('Communications module not available', 'MODULE_NOT_AVAILABLE');
        if (!params.messageIds || !Array.isArray(params.messageIds)) {
          throw new SphereError('Missing required parameter: messageIds (string[])', 'VALIDATION_ERROR');
        }
        await comms.markAsRead(params.messageIds as string[]);
        return { marked: true, count: (params.messageIds as string[]).length };
      }

      case RPC_METHODS.GET_INVOICES: {
        const accounting = sphere.accounting;
        if (!accounting) throw new SphereError('Accounting module not available', 'MODULE_NOT_AVAILABLE');
        // W23-R2 fix: Extract only known fields to prevent unsanitized dApp params
        // from reaching the module (defense-in-depth).
        const invoiceOpts: Record<string, unknown> = {};
        if (params.state !== undefined) invoiceOpts.state = params.state;
        if (params.limit !== undefined) invoiceOpts.limit = params.limit;
        if (params.offset !== undefined) invoiceOpts.offset = params.offset;
        if (params.sortBy !== undefined) invoiceOpts.sortBy = params.sortBy;
        if (params.sortOrder !== undefined) invoiceOpts.sortOrder = params.sortOrder;
        if (params.createdByMe !== undefined) invoiceOpts.createdByMe = params.createdByMe;
        if (params.targetingMe !== undefined) invoiceOpts.targetingMe = params.targetingMe;
        return accounting.getInvoices(invoiceOpts);
      }

      case RPC_METHODS.GET_INVOICE_STATUS: {
        const accounting = sphere.accounting;
        if (!accounting) throw new SphereError('Accounting module not available', 'MODULE_NOT_AVAILABLE');
        if (!params.invoiceId || typeof params.invoiceId !== 'string') {
          throw new SphereError('Missing required parameter: invoiceId', 'VALIDATION_ERROR');
        }
        return accounting.getInvoiceStatus(params.invoiceId as string);
      }

      default:
        throw new SphereError(`Unknown method: ${method}`, 'VALIDATION_ERROR');
    }
  }

  // ===========================================================================
  // Event Subscriptions
  // ===========================================================================

  private autoSubscribeIdentityChanged(): void {
    if (this.eventSubscriptions.has(WALLET_EVENTS.IDENTITY_CHANGED)) return;
    const unsub = this.requireSphere().on('identity:changed' as SphereEventType, (data: unknown) => {
      this.pushClientEvent(WALLET_EVENTS.IDENTITY_CHANGED, data);
    });
    this.eventSubscriptions.set(WALLET_EVENTS.IDENTITY_CHANGED, unsub);
  }

  private handleSubscribe(eventName: string): { subscribed: boolean; event: string } {
    if (!eventName) throw new SphereError('Missing required parameter: event', 'VALIDATION_ERROR');

    // The four auto-pushed events must NOT be attached to Sphere.on(): it accepts any string
    // and never emits for them, so the subscription would deliver nothing forever. But the
    // answer is SUCCESS, not an error — the host pushes them unconditionally, so "you are
    // subscribed" is true, just satisfied by a different mechanism.
    //
    // Throwing here surfaced as INTERNAL_ERROR -32603 and silently broke every dApp built
    // before 2.1: `client.on('wallet:locked', …)` fires sphere_subscribe fire-and-forget, and
    // on 2.0 that call succeeded. A MINOR bump must not turn a working call into a crash. The
    // 2.1 client skips the call altogether, so this path exists only for older dApps.
    if (isAutoPushedEvent(eventName)) {
      return { subscribed: true, event: eventName };
    }

    // While locked there is no Sphere to attach to: record the KEY and answer success.
    // Refusing would be a bug, not a policy — ConnectClient.on() fires sphere_subscribe
    // fire-and-forget and never retries, so the stream would die forever after one lock.
    if (this._walletState === 'locked') {
      this.suspendedSubscriptions.add(eventName);
      return { subscribed: true, event: eventName };
    }

    if (this.eventSubscriptions.has(eventName)) {
      return { subscribed: true, event: eventName };
    }

    const unsub = this.requireSphere().on(eventName as SphereEventType, (data: unknown) => {
      this.transport.send({
        ns: SPHERE_CONNECT_NAMESPACE,
        v: SPHERE_CONNECT_VERSION,
        type: 'event',
        event: eventName,
        data,
      });
    });

    this.eventSubscriptions.set(eventName, unsub);
    return { subscribed: true, event: eventName };
  }

  private handleUnsubscribe(eventName: string): { unsubscribed: boolean; event: string } {
    if (!eventName) throw new SphereError('Missing required parameter: event', 'VALIDATION_ERROR');

    const unsub = this.eventSubscriptions.get(eventName);
    if (unsub) {
      unsub();
      this.eventSubscriptions.delete(eventName);
    }
    // Also drop it from the lock snapshot: sphere_unsubscribe is on the locked allow-list,
    // so without this the next updateSphere() re-arm would resurrect the stream.
    this.suspendedSubscriptions.delete(eventName);
    return { unsubscribed: true, event: eventName };
  }

  private cleanupEventSubscriptions(): void {
    for (const [, unsub] of this.eventSubscriptions) {
      unsub();
    }
    this.eventSubscriptions.clear();
  }

  // ===========================================================================
  // Helpers
  // ===========================================================================

  /** Push an event to the dApp without requiring a sphere_subscribe call. */
  private pushClientEvent(event: string, data: unknown): void {
    this.transport.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: 'event',
      event,
      data,
    });
  }

  /** The bound Sphere, or a typed refusal. The ONLY way the router may reach Sphere.
   *  Unreachable in practice — the gate guarantees 'live' before the router is entered —
   *  so this is defence in depth, not the primary mechanism. */
  private requireSphere(): SphereInstance {
    if (!this.sphere) {
      throw new SphereError(
        this._walletState === 'locked' ? WALLET_LOCKED_MESSAGE : 'Wallet unavailable',
        'NOT_INITIALIZED',
      );
    }
    return this.sphere;
  }

  /** SNAPSHOT read. `undefined` means "we never saw an identity": callers MUST refuse,
   *  never answer undefined-as-success — a dApp reads that as "the wallet has no
   *  identity". Two explicit methods instead of one dual-mode method, so nobody can serve
   *  a snapshot believing it is live. */
  private snapshotIdentity(): PublicIdentity | undefined {
    return this.snapshot.identity;
  }

  /** InFlightRegistry.onExpire sink. Filled in a later task; declared here so the
   *  constructor can wire it. */
  private settleExpired(entry: InFlightEntry): void {
    logger.warn(
      'ConnectHost',
      `Host deadline reached, answering on our own: ${entry.kind} ${entry.id} (origin=${this.config.origin ?? 'unverified'})`,
    );
    if (entry.kind === 'query') {
      this.sendError(entry.id, ERROR_CODES.INTERNAL_ERROR, INTERNAL_ERROR_MESSAGE);
    } else {
      // NOT INTENT_CANCELLED. The wallet was handed this intent and may already have submitted
      // the transfer — the deadline says only that we stopped waiting for the answer, never
      // that nothing happened. Asserting a cancel here is how a dApp re-offers a payment that
      // already went through.
      this.sendIntentError(entry.id, ERROR_CODES.INTENT_OUTCOME_UNKNOWN, INTENT_UNKNOWN_MESSAGE);
    }
  }

  /** Answer every request already in flight with one coded frame each. A request in flight
   *  when the Sphere goes away otherwise answers -32603 with a raw JS message, returns
   *  `undefined` AS SUCCESS (sphere_getIdentity), or — for a delegated intent — never
   *  answers at all until the client's own 120 s timeout. */
  private settleInFlight(code: number, message: string, data?: WalletLockedData): void {
    for (const entry of this.inFlight.settleAll()) {
      if (entry.kind === 'query') {
        this.sendError(entry.id, code, message, data);
        continue;
      }
      // An INTENT is never answered with the caller's code. 4009 invites a retry after the
      // unlock and 4001 reads as "never happened", but this intent was already delegated to
      // the wallet: the user may have confirmed it and the transfer may be on the wire. Only
      // "outcome unknown" is true, and it explicitly forbids a retry.
      this.sendIntentError(entry.id, ERROR_CODES.INTENT_OUTCOME_UNKNOWN, INTENT_UNKNOWN_MESSAGE);
    }
  }

  /**
   * Notify-only. The host has ALREADY answered and never waits for the wallet.
   *
   * The wallet's only permitted reaction is a PASSIVE badge in its PERMANENT chrome; a
   * dApp request may trigger a CONSENT prompt but never a credential prompt. Volume is
   * bounded by checkRateLimit(), which guards all three entry points — there is no
   * coalescing, no cooldown and no cap by design.
   *
   * A throwing handler must not break the host.
   */
  private notifyLockedRequest(kind: LockedRequestContext['kind'], name: string): void {
    try {
      this.config.onLockedRequest?.({ origin: this.config.origin, kind, name });
    } catch (err) {
      logger.warn('ConnectHost', 'onLockedRequest handler error', err);
    }
  }

  /** Last-resort answer for a handler that threw before its own catch could run.
   *  Id-bearing frames get a coded error (InFlightRegistry guarantees exactly one answer
   *  per id); a handshake gets today's empty refusal, because a failed handshake must
   *  reveal nothing. */
  private sendUnhandledError(msg: SphereConnectMessage, error: unknown): void {
    if (msg.type === 'request') {
      if (!this.inFlight.settle(msg.id) && this.inFlight.has(msg.id)) return;
      this.sendError(msg.id, ERROR_CODES.INTERNAL_ERROR, INTERNAL_ERROR_MESSAGE);
      return;
    }
    if (msg.type === 'intent') {
      this.inFlight.settle(msg.id);
      this.sendIntentError(msg.id, ERROR_CODES.INTERNAL_ERROR, INTERNAL_ERROR_MESSAGE);
      return;
    }
    if (msg.type === 'handshake' && msg.direction === 'request') {
      logger.warn('ConnectHost', 'Handshake handler threw; sending the empty refusal', error);
      this.sendHandshakeResponse([], undefined, undefined);
    }
  }

  private getPublicIdentity(): PublicIdentity | undefined {
    const id = this.requireSphere().identity;
    if (!id) return undefined;
    return {
      chainPubkey: id.chainPubkey,
      directAddress: id.directAddress,
      nametag: id.nametag,
    };
  }

  private stripTokenSdkData(tokens: unknown[]): unknown[] {
    return tokens.map((t) => {
      const token = t as Record<string, unknown>;
      // Return all fields except internal sdkData
      const { sdkData: _sdkData, ...publicFields } = token;
      return publicFields;
    });
  }

  private sendResult(id: string, result: unknown): void {
    this.transport.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: 'response',
      id,
      result,
    });
  }

  private sendError(id: string, code: number, message: string, data?: unknown): void {
    this.transport.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: 'response',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  private sendIntentResult(id: string, result: unknown): void {
    this.transport.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: 'intent_result',
      id,
      result,
    });
  }

  private sendIntentError(id: string, code: number, message: string, data?: unknown): void {
    this.transport.send({
      ns: SPHERE_CONNECT_NAMESPACE,
      v: SPHERE_CONNECT_VERSION,
      type: 'intent_result',
      id,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    });
  }

  private checkRateLimit(): boolean {
    const maxRps = this.config.maxRequestsPerSecond ?? DEFAULT_MAX_RPS;
    const now = Date.now();
    if (now > this.rateLimitResetAt) {
      this.rateLimitCounter = 0;
      this.rateLimitResetAt = now + 1000;
    }
    this.rateLimitCounter++;
    return this.rateLimitCounter <= maxRps;
  }
}
