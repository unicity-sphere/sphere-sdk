/**
 * Sphere provider lifecycle + connection event bridge — Wave 6-P2-8b
 * extraction from `core/Sphere.ts`.
 *
 * Owns:
 *   - Runtime provider disable / enable (public
 *     {@link disableProviderImpl} / {@link enableProviderImpl}), plus
 *     the {@link findProviderByIdImpl} lookup that walks all provider
 *     collections.
 *   - {@link reconnectImpl} — transport-level reconnect.
 *   - {@link subscribeToProviderEventsImpl} — bridge transport / oracle
 *     / token-storage events onto Sphere's `connection:changed` (with
 *     dedup) and forward the pointer-published RFC-251 broadcast.
 *   - {@link forwardPointerPublishedToNostrImpl} — Approach D publisher
 *     side.
 *   - {@link maybeInstallPointerWinSubscriptionImpl} +
 *     {@link handleIncomingPointerWinBroadcastImpl} — Approach D
 *     subscriber side (issue #255 / issue #264).
 *   - {@link emitConnectionChangedImpl} — dedup-guarded event fanout.
 *   - {@link cleanupProviderEventSubscriptionsImpl} — teardown for all
 *     of the above.
 *
 * Behavior-preserving: bodies moved verbatim behind a
 * {@link ProvidersHost} shim. Every JSDoc + inline comment on the
 * moved methods is preserved. Sphere.ts retains thin delegators
 * (public where they were public, private otherwise).
 */

import { logger } from './logger';
import { SphereError } from './errors';
import type {
  ProviderStatus,
  SphereEventType,
  SphereEventMap,
} from '../types';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../storage';
import type { TransportProvider } from '../transport';
import type { OracleProvider } from '../oracle';
import type { PriceProvider } from '../price';

/**
 * Host shim for the provider lifecycle ops. Mirrors the Sphere-private
 * state the moved methods reach for. Several fields are mutable:
 * `_providerEventCleanups` is reassigned during teardown,
 * `_pointerWinInstallInFlight` guards the subscription install, and
 * the disabled-set / seen-set / subs-map / last-connected map are all
 * mutated in place.
 */
export interface ProvidersHost {
  readonly _storage: StorageProvider;
  readonly _transport: TransportProvider;
  readonly _oracle: OracleProvider;
  readonly _priceProvider: PriceProvider | null;
  readonly _tokenStorageProviders: Map<string, TokenStorageProvider<TxfStorageDataBase>>;
  readonly _disabledProviders: Set<string>;
  _providerEventCleanups: (() => void)[];
  readonly _lastProviderConnected: Map<string, boolean>;
  readonly _pointerWinSubscriptions: Map<string, () => void>;
  readonly _pointerWinSeen: Set<string>;
  _pointerWinInstallInFlight: boolean;
  readonly _priceProviderId: string;

  emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
}

export async function reconnectImpl(host: ProvidersHost): Promise<void> {
  await host._transport.disconnect();
  await host._transport.connect();
  // connection:changed is emitted automatically by provider event bridge
}

/**
 * Disable a provider at runtime. The provider stays registered but is disconnected
 * and skipped during operations (e.g., sync).
 *
 * Main storage provider cannot be disabled.
 *
 * @returns true if successfully disabled, false if provider not found
 */
export async function disableProviderImpl(host: ProvidersHost, providerId: string): Promise<boolean> {
  if (providerId === host._storage.id) {
    throw new SphereError('Cannot disable the main storage provider', 'INVALID_CONFIG');
  }

  const provider = findProviderByIdImpl(host, providerId);
  if (!provider) return false;

  host._disabledProviders.add(providerId);

  try {
    if ('disable' in provider && typeof provider.disable === 'function') {
      // L1PaymentsModule — dedicated disable that disconnects + blocks operations
      provider.disable();
    } else if ('shutdown' in provider && typeof provider.shutdown === 'function') {
      await provider.shutdown();
    } else if ('disconnect' in provider && typeof provider.disconnect === 'function') {
      await provider.disconnect();
    } else if ('clearCache' in provider && typeof provider.clearCache === 'function') {
      // Stateless providers (e.g. PriceProvider) — just clear cache
      provider.clearCache();
    }
  } catch {
    // Provider disconnect may fail — still mark as disabled
  }

  host.emitEvent('connection:changed', {
    provider: providerId,
    connected: false,
    status: 'disconnected',
    enabled: false,
  });

  return true;
}

/**
 * Re-enable a previously disabled provider. Reconnects and resumes operations.
 *
 * @returns true if successfully enabled, false if provider not found
 */
export async function enableProviderImpl(host: ProvidersHost, providerId: string): Promise<boolean> {
  const provider = findProviderByIdImpl(host, providerId);
  if (!provider) return false;

  host._disabledProviders.delete(providerId);

  // L1 — dedicated enable(), reconnects lazily on next operation
  if ('enable' in provider && typeof provider.enable === 'function') {
    provider.enable();
    host.emitEvent('connection:changed', {
      provider: providerId,
      connected: false,
      status: 'disconnected',
      enabled: true,
    });
    return true;
  }

  // Stateless providers (PriceProvider) — no connect needed
  const hasLifecycle = ('connect' in provider && typeof provider.connect === 'function')
    || ('initialize' in provider && typeof provider.initialize === 'function');

  if (hasLifecycle) {
    try {
      if ('connect' in provider && typeof provider.connect === 'function') {
        await provider.connect();
      } else if ('initialize' in provider && typeof provider.initialize === 'function') {
        await provider.initialize();
      }
    } catch (err) {
      host.emitEvent('connection:changed', {
        provider: providerId,
        connected: false,
        status: 'error',
        enabled: true,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  host.emitEvent('connection:changed', {
    provider: providerId,
    connected: true,
    status: 'connected',
    enabled: true,
  });

  return true;
}

/**
 * Check if a provider is currently enabled
 */
export function isProviderEnabledImpl(host: ProvidersHost, providerId: string): boolean {
  return !host._disabledProviders.has(providerId);
}

/**
 * Get the set of disabled provider IDs (for passing to modules)
 */
export function getDisabledProviderIdsImpl(host: ProvidersHost): ReadonlySet<string> {
  return host._disabledProviders;
}

/**
 * Find a provider by ID across all provider collections
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function findProviderByIdImpl(host: ProvidersHost, providerId: string): Record<string, any> | null {
  if (host._storage.id === providerId) return host._storage;
  if (host._transport.id === providerId) return host._transport;
  if (host._oracle.id === providerId) return host._oracle;
  if (host._tokenStorageProviders.has(providerId)) {
    return host._tokenStorageProviders.get(providerId)!;
  }
  if (host._priceProvider && host._priceProviderId === providerId) {
    return host._priceProvider;
  }
  return null;
}

/**
 * Subscribe to provider-level events and bridge them to Sphere connection:changed events.
 * Uses deduplication to avoid emitting duplicate events.
 */
export function subscribeToProviderEventsImpl(host: ProvidersHost): void {
  cleanupProviderEventSubscriptionsImpl(host);

  // Bridge transport events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const transportAny = host._transport as any;
  if (typeof transportAny.onEvent === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = transportAny.onEvent((event: any) => {
      const type = event?.type as string;
      if (type === 'transport:connected') {
        emitConnectionChangedImpl(host, host._transport.id, true, 'connected');
      } else if (type === 'transport:disconnected') {
        emitConnectionChangedImpl(host, host._transport.id, false, 'disconnected');
      } else if (type === 'transport:reconnecting') {
        emitConnectionChangedImpl(host, host._transport.id, false, 'connecting');
      } else if (type === 'transport:error') {
        emitConnectionChangedImpl(host, host._transport.id, false, 'error', event?.error);
      }
    });
    if (unsub) host._providerEventCleanups.push(unsub);
  }

  // Bridge oracle events
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oracleAny = host._oracle as any;
  if (typeof oracleAny.onEvent === 'function') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsub = oracleAny.onEvent((event: any) => {
      const type = event?.type as string;
      if (type === 'oracle:connected') {
        emitConnectionChangedImpl(host, host._oracle.id, true, 'connected');
      } else if (type === 'oracle:disconnected') {
        emitConnectionChangedImpl(host, host._oracle.id, false, 'disconnected');
      } else if (type === 'oracle:error') {
        emitConnectionChangedImpl(host, host._oracle.id, false, 'error', event?.error);
      }
    });
    if (unsub) host._providerEventCleanups.push(unsub);
  }

  // Bridge token storage events
  for (const [providerId, provider] of host._tokenStorageProviders) {
    if (typeof provider.onEvent === 'function') {
      const unsub = provider.onEvent((event) => {
        if (event.type === 'storage:error' || event.type === 'sync:error') {
          emitConnectionChangedImpl(host, providerId, provider.isConnected(), provider.getStatus(), event.error);
        }
        // RFC-251 Approach D / issue #255 Problem B — pointer-publish
        // win-broadcast publisher side. After the lifecycle manager
        // emits a `storage:pointer-published` event (containing the
        // already-signed payload + broadcast tag), forward it to
        // Nostr so sibling devices sharing this wallet's identity
        // can adopt V=N without waiting for the aggregator's 30-60s
        // read-replica lag.
        //
        // Best-effort: any failure (transport down, relay reject) is
        // logged and dropped. The aggregator publish has already
        // succeeded; the wallet's own state is correct without the
        // broadcast. Siblings just fall back to the existing
        // WALKBACK_FLOOR + reconcile path (~60-90 s).
        if (event.type === 'storage:pointer-published') {
          void forwardPointerPublishedToNostrImpl(host, event);
          // Also try to install the sibling-subscription side now
          // that we know a pointer layer is live (signing is what
          // produced this event). Idempotent — repeat calls no-op
          // when the subscription is already in place.
          void maybeInstallPointerWinSubscriptionImpl(host);
        }
        // Issue #264 — bridge `storage:monotonicity-recovered` to a
        // user-visible Sphere event so dashboards / telemetry
        // pipelines subscribing via `sphere.on(...)` can observe
        // auto-merge convergence work without dropping to provider-
        // direct subscriptions. Pure informational forward — the
        // provider's data payload rides through verbatim with
        // `providerId` added for fan-out attribution.
        if (event.type === 'storage:monotonicity-recovered') {
          const d = (event.data ?? {}) as {
            recoveredTokenIds?: string[];
            recoveredTokenCount?: number;
            mergedUnknownBundleCids?: string[];
            mergedUnknownBundleCount?: number;
            residualUnknownBundleCids?: string[];
            residualUnknownBundleCount?: number;
            residualTokenMissingIds?: string[];
            residualTokenMissingCount?: number;
            recoveredOutboxIdsDroppedAsSent?: string[];
            recoveredOutboxIdsDroppedAsSentCount?: number;
            truncated?: boolean;
          };
          host.emitEvent('storage:monotonicity-recovered', {
            providerId,
            recoveredTokenIds: d.recoveredTokenIds ?? [],
            recoveredTokenCount: d.recoveredTokenCount ?? 0,
            mergedUnknownBundleCids: d.mergedUnknownBundleCids ?? [],
            mergedUnknownBundleCount: d.mergedUnknownBundleCount ?? 0,
            residualUnknownBundleCids: d.residualUnknownBundleCids ?? [],
            residualUnknownBundleCount: d.residualUnknownBundleCount ?? 0,
            residualTokenMissingIds: d.residualTokenMissingIds ?? [],
            residualTokenMissingCount: d.residualTokenMissingCount ?? 0,
            recoveredOutboxIdsDroppedAsSent: d.recoveredOutboxIdsDroppedAsSent ?? [],
            recoveredOutboxIdsDroppedAsSentCount: d.recoveredOutboxIdsDroppedAsSentCount ?? 0,
            truncated: d.truncated === true,
          });
        }
      });
      if (unsub) host._providerEventCleanups.push(unsub);
    }
  }
}

/**
 * RFC-251 Approach D / issue #255 Problem B — publisher side.
 *
 * Receives a `storage:pointer-published` event from the lifecycle
 * manager (which carries an already-signed broadcast payload + its
 * per-wallet tag) and forwards it over Nostr. Best-effort:
 * - No publish? Drop silently (transport doesn't support broadcasts
 *   — falls back to existing WALKBACK_FLOOR convergence).
 * - Publish throws? Log warn and drop.
 *
 * The signing happened upstream (in lifecycle-manager where the
 * pointer layer is reachable). This method does pure transport I/O.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function forwardPointerPublishedToNostrImpl(host: ProvidersHost, event: any): Promise<void> {
  try {
    const data = event?.data as
      | {
          signedPayloadJson?: unknown;
          broadcastTag?: unknown;
          version?: unknown;
          cid?: unknown;
        }
      | undefined;
    const signedPayloadJson = data?.signedPayloadJson;
    const broadcastTag = data?.broadcastTag;
    if (
      typeof signedPayloadJson !== 'string' ||
      typeof broadcastTag !== 'string' ||
      signedPayloadJson.length === 0 ||
      broadcastTag.length === 0
    ) {
      // Event shape didn't include the signed payload (e.g. pointer
      // layer absent at sign time, or upstream sign failure). Caller
      // already logged the sign error; nothing useful to publish.
      return;
    }
    if (typeof host._transport.publishBroadcast !== 'function') {
      // Transport doesn't support broadcasts (e.g., file-only mock).
      // Silently skip — the existing WALKBACK_FLOOR path still
      // handles cross-device convergence.
      return;
    }
    await host._transport.publishBroadcast(signedPayloadJson, [broadcastTag]);
    logger.debug(
      'Sphere',
      `pointer-win broadcast published: version=${String(data?.version ?? '?')} ` +
      `cid=${String(data?.cid ?? '?')} tag=${broadcastTag}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      'Sphere',
      `pointer-win broadcast publish failed (best-effort, ignored): ${msg}`,
    );
  }
}

/**
 * RFC-251 Approach D / issue #255 Problem B — subscriber side.
 *
 * Install the per-wallet Nostr subscription so this device receives
 * pointer-win broadcasts from sibling devices sharing the same
 * wallet identity. Idempotent — safe to call repeatedly; once the
 * subscription is in place for a given signing pubkey, subsequent
 * invocations short-circuit.
 *
 * Pointer layer is built async during OrbitDB attach, so the
 * subscription cannot be installed at Sphere init time. Two
 * triggers eventually fire `maybeInstallPointerWinSubscription`:
 *   - Lazy-on-own-publish: our own first `storage:pointer-published`
 *     event implies pointer is live. We install then.
 *   - (Phase 2 expansion) An eager polling loop after init for
 *     receive-only devices that never publish themselves. NOT
 *     wired in Phase 1 — those devices currently miss broadcasts
 *     until they themselves publish at least once. Acceptable for
 *     prototype; document as known-gap.
 */
export async function maybeInstallPointerWinSubscriptionImpl(host: ProvidersHost): Promise<void> {
  if (host._pointerWinInstallInFlight) return;
  host._pointerWinInstallInFlight = true;
  try {
    const storageWithPointer = host._storage as unknown as {
      getPointerLayer?: () =>
        | import('../extensions/uxf/profile/aggregator-pointer/ProfilePointerLayer').ProfilePointerLayer
        | null;
    };
    const pointer = storageWithPointer.getPointerLayer?.() ?? null;
    if (!pointer) {
      // Pointer layer not yet built; try again on the next event.
      return;
    }
    // Issue #264 — gated behind the pointer layer's
    // `enablePointerWinBroadcasts` capability (default OFF). With
    // the flag false this subscriber side is dormant: no per-wallet
    // Nostr subscription is installed, so no sibling broadcasts can
    // reach `handleIncomingPointerWinBroadcast`. The aggregator
    // pointer + auto-merge convergence path covers correctness
    // without the broadcast optimization.
    //
    // Tolerant of pointer stubs that predate the
    // `winBroadcastsEnabled` accessor (mirrors the symmetric guard
    // in `lifecycle-manager.ts:publishAggregatorPointerBestEffort`):
    // a missing method is treated as flag=false (fail-closed). The
    // production code path always builds a real `ProfilePointerLayer`
    // which implements the method; this defensive check keeps the
    // contract robust for any future test stub or duck-typed
    // consumer.
    // Defensive try/catch around the accessor: same rationale as
    // lifecycle-manager. The accessor contract says
    // `winBroadcastsEnabled()` MUST NOT throw, but a misbehaving
    // stub could violate it. Without this catch, an accessor
    // throw would escape to the outer `try { ... } catch (err)`
    // and surface as a noisy "subscription install failed (will
    // retry on next event)" warn — re-arming on every subsequent
    // `storage:pointer-published` event indefinitely. Treat the
    // throw as flag=false (fail-closed) so the early-return path
    // fires cleanly with no noise.
    let armed = false;
    try {
      armed =
        typeof pointer.winBroadcastsEnabled === 'function' &&
        // Strict `=== true` mirrors the production normalization
        // in ProfilePointerLayer's frozen config snapshot. A test
        // stub returning a truthy non-boolean (`1`, `'yes'`, `{}`)
        // must be treated as flag=false — same fail-closed policy.
        pointer.winBroadcastsEnabled() === true &&
        // Symmetric stub guard: a fake pointer that returns
        // `winBroadcastsEnabled() === true` but lacks
        // `getSignerForWinBroadcast` would TypeError at the call
        // below; fail-closed earlier.
        typeof pointer.getSignerForWinBroadcast === 'function';
    } catch (accessorErr) {
      const msg =
        accessorErr instanceof Error
          ? accessorErr.message
          : String(accessorErr);
      logger.debug(
        'Sphere',
        `pointer-win subscription: winBroadcastsEnabled() threw ` +
          `(accessor contract violation, treating as flag=false): ${msg}`,
      );
      armed = false;
    }
    if (!armed) {
      return;
    }
    const signerHandle = pointer.getSignerForWinBroadcast();
    const signingPubKeyHex = signerHandle.signingPubKeyHex;
    if (host._pointerWinSubscriptions.has(signingPubKeyHex)) {
      // Already subscribed for this wallet identity.
      return;
    }
    if (typeof host._transport.subscribeToBroadcast !== 'function') {
      return;
    }

    // Late-imported to avoid pulling the win-broadcast module into the
    // happy path for wallets that disable pointer broadcasts entirely.
    const {
      buildWinBroadcastTag,
      verifyWinBroadcastPayload,
    } = await import('../extensions/uxf/profile/aggregator-pointer/win-broadcast');
    const tag = buildWinBroadcastTag(signingPubKeyHex);

    const unsub = host._transport.subscribeToBroadcast(
      [tag],
      (broadcast) => {
        void handleIncomingPointerWinBroadcastImpl(host, broadcast.content, signingPubKeyHex, pointer, verifyWinBroadcastPayload);
      },
    );
    host._pointerWinSubscriptions.set(signingPubKeyHex, unsub);
    logger.debug(
      'Sphere',
      `pointer-win subscription installed: tag=${tag}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      'Sphere',
      `pointer-win subscription install failed (will retry on next event): ${msg}`,
    );
  } finally {
    host._pointerWinInstallInFlight = false;
  }
}

/**
 * Handle an incoming pointer-win broadcast from a sibling device.
 *
 * Flow:
 *   1. Parse JSON content.
 *   2. Verify signature against own signingPubKey (signature mismatch
 *      = spoofed or wrong-wallet event; drop silently).
 *   3. Dedup by (signingPubKey, version) — bounded LRU.
 *   4. Trigger early reconcile: `recoverLatest()` + `reconcileLocalVersionDownward()`.
 *      Same path the WALKBACK_FLOOR catch arm runs (lifecycle-manager.ts
 *      lines 1311-1331), just collapsed to "now" instead of "60s
 *      throttle expiry".
 *
 * All errors are caught and logged at debug — never propagate to the
 * transport handler.
 */
export async function handleIncomingPointerWinBroadcastImpl(
  host: ProvidersHost,
  contentJson: string,
  ownSigningPubKeyHex: string,
  pointer: import('../extensions/uxf/profile/aggregator-pointer/ProfilePointerLayer').ProfilePointerLayer,
  verify: (
    payload: import('../extensions/uxf/profile/aggregator-pointer/win-broadcast').SignedWinBroadcastPayload,
    expectedSigningPubKeyHex: string,
  ) => Promise<boolean>,
): Promise<void> {
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(contentJson);
    } catch {
      // Not our JSON; relay-noise on the same tag (improbable but
      // defensive). Drop.
      return;
    }
    const payload = parsed as import('../extensions/uxf/profile/aggregator-pointer/win-broadcast').SignedWinBroadcastPayload;
    const ok = await verify(payload, ownSigningPubKeyHex);
    if (!ok) {
      logger.debug(
        'Sphere',
        'pointer-win broadcast: verification failed (spoof, expired, or wrong-wallet); dropped',
      );
      return;
    }
    const dedupKey = `${payload.signingPubKey}:${payload.version}`;
    if (host._pointerWinSeen.has(dedupKey)) {
      return;
    }
    // Bounded LRU — drop oldest insertion when over cap.
    if (host._pointerWinSeen.size >= 256) {
      const oldest = host._pointerWinSeen.values().next().value;
      if (oldest !== undefined) host._pointerWinSeen.delete(oldest);
    }
    host._pointerWinSeen.add(dedupKey);

    logger.debug(
      'Sphere',
      `pointer-win broadcast received: version=${payload.version} ` +
      `cid=${payload.cid} — triggering early reconcile`,
    );

    // Phase 1: trigger an early `recoverLatest` + `reconcileLocalVersionDownward`.
    // This is the same path the WALKBACK_FLOOR catch arm runs after a
    // race-loss; here we run it eagerly on the broadcast without
    // waiting for the throttle to expire. Acknowledged limitation:
    // when own localVersion is already at broadcast.version (same-
    // version race), reconcileDownward is a no-op — Phase 2 would add
    // a `ProfilePointerLayer.adoptBroadcast(payload)` entrypoint that
    // bypasses the >= comparison. For Phase 1 this still helps the
    // cross-version case where own localVersion < broadcast.version.
    const recovered = await pointer.recoverLatest();
    // `'cid' in recovered` narrows RecoverResult | RecoverAllUnfetchableResult
    // to RecoverResult — RecoverAllUnfetchableResult has no `cid` field.
    // RecoverAllUnfetchableResult has no fetchable version to adopt, so skip.
    if (recovered && 'cid' in recovered) {
      const outcome = await pointer.reconcileLocalVersionDownward(recovered);
      logger.debug(
        'Sphere',
        `pointer-win broadcast: post-receipt reconcile ` +
        `reconciled=${outcome.reconciled} ` +
        `fromVersion=${outcome.fromVersion} toVersion=${outcome.toVersion}`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.debug(
      'Sphere',
      `pointer-win broadcast: handler threw (dropped): ${msg}`,
    );
  }
}

/**
 * Emit connection:changed with deduplication — only emits if status actually changed.
 */
export function emitConnectionChangedImpl(
  host: ProvidersHost,
  providerId: string,
  connected: boolean,
  status: ProviderStatus,
  error?: string,
): void {
  const lastConnected = host._lastProviderConnected.get(providerId);
  if (lastConnected === connected) return; // No change — skip

  host._lastProviderConnected.set(providerId, connected);

  host.emitEvent('connection:changed', {
    provider: providerId,
    connected,
    status,
    enabled: !host._disabledProviders.has(providerId),
    ...(error ? { error } : {}),
  });
}

export function cleanupProviderEventSubscriptionsImpl(host: ProvidersHost): void {
  for (const cleanup of host._providerEventCleanups) {
    try { cleanup(); } catch { /* ignore */ }
  }
  host._providerEventCleanups = [];
  host._lastProviderConnected.clear();
  // RFC-251 Approach D — also tear down per-wallet pointer-win
  // broadcast subscriptions to avoid relay-side subscription leaks
  // across Sphere reinit cycles. Defensive: legacy test harnesses
  // construct Sphere via `Object.create(prototype)` which skips
  // class-field initializers, leaving these fields undefined. Skip
  // the cleanup cleanly when the state never got installed.
  if (host._pointerWinSubscriptions !== undefined) {
    for (const unsub of host._pointerWinSubscriptions.values()) {
      try { unsub(); } catch { /* ignore */ }
    }
    host._pointerWinSubscriptions.clear();
  }
  if (host._pointerWinSeen !== undefined) {
    host._pointerWinSeen.clear();
  }
  host._pointerWinInstallInFlight = false;
}
