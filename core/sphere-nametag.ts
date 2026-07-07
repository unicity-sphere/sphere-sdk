/**
 * Sphere nametag ceremony — Wave 6-P2-8b extraction from `core/Sphere.ts`.
 *
 * Owns the caller-facing nametag surface and the two-phase
 * (mint-then-publish) registration ceremony that binds a nametag to
 * the current active address. The Sphere facade retains thin public
 * delegators so `sphere.registerNametag(...)`, `sphere.mintNametag(...)`,
 * `sphere.isNametagAvailable(...)`, `sphere.getNametag()` and
 * `sphere.hasNametag()` keep working unchanged.
 *
 * Behavior-preserving: bodies moved verbatim behind a
 * {@link NametagCeremonyHost} shim. Every JSDoc + inline comment on
 * the moved methods is preserved. The private helpers
 * (`_handleDetachedPublishOutcome`, `_rollbackOrphanNametagMint`,
 * `_updateCachedProxyAddress`) become internal free functions in this
 * file — the ones still called from other Sphere.ts code paths (like
 * `_updateCachedProxyAddress` from init / switchToAddress) retain thin
 * private delegators on the class.
 */

import { logger } from './logger';
import { SphereError } from './errors';
import { normalizeNametag } from '@unicitylabs/nostr-js-sdk';
import type {
  FullIdentity,
  TrackedAddress,
  SphereEventType,
  SphereEventMap,
} from '../types';
import type { TransportProvider } from '../transport';
import type { PaymentsModule, MintNametagResult } from '../modules/payments';
import { isValidNametag } from './Sphere';

/** Mutable version of FullIdentity — matches Sphere's internal alias. */
export type MutableFullIdentity = {
  -readonly [K in keyof FullIdentity]: FullIdentity[K];
};

/**
 * Captured Sphere state passed to `_handleDetachedPublishOutcome` so
 * the async rollback / event fanout can run on the address we minted
 * for even if a concurrent `switchToAddress(N)` has since swapped
 * `this._payments` / `this._currentAddressIndex` / `this._identity`.
 *
 * `payments` is the PaymentsModule reference at dispatch time —
 * `switchToAddress` rotates `this._payments` to the new address's
 * module (Sphere.ts ~line 3682), so a live reference would clear
 * the wrong wallet's nametag store.
 *
 * `addressIndex` and `addressId` pin the tracked-address entry
 * whose nametag cache must be cleared on rollback.
 *
 * `identityRef` is the same `MutableFullIdentity` object we mutated
 * in step 3 of `registerNametag`. We hold a reference (not a copy)
 * because that's the object whose `.nametag = undefined` clear
 * propagates to the cached identity getter. A switch-then-switch-
 * back round trip leaves the original `identityRef` detached from
 * `this._identity`; the handler uses identity-equality
 * (`this._identity === ctx.identityRef`) to know whether to refresh
 * the cached proxy address.
 */
export interface DetachedPublishContext {
  readonly payments: PaymentsModule;
  readonly addressIndex: number;
  readonly addressId: string | undefined;
  readonly identityRef: MutableFullIdentity | null;
}

/**
 * Host shim for the nametag ceremony. Mirrors the Sphere fields and
 * helpers that the moved methods reach for. `_identity` is mutable —
 * `registerNametag` and the detached publish handler patch
 * `_identity.nametag` in place. `_cachedProxyAddress` is likewise
 * mutable — `_updateCachedProxyAddress` writes `undefined` after v2
 * removed ProxyAddress entirely (Phase 6).
 */
export interface NametagCeremonyHost {
  readonly _transport: TransportProvider;
  _identity: MutableFullIdentity | null;
  readonly _currentAddressIndex: number;
  readonly _trackedAddresses: Map<number, TrackedAddress>;
  readonly _addressNametags: Map<string, Map<number, string>>;
  readonly _payments: PaymentsModule;
  readonly _initialized: boolean;
  _cachedProxyAddress: string | undefined;

  ensureReady(): void;
  persistAddressNametags(): Promise<void>;
  emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
  /**
   * Route the ceremony's mint step through the Sphere-level wrapper so
   * consumers (and unit tests) that mock `Sphere.prototype.mintNametag`
   * intercept the call. Bypassing this and calling `_payments.mintNametag`
   * directly would defeat those mocks.
   */
  mintNametag(nametag: string): Promise<MintNametagResult>;
}

/** Strip @ prefix and normalize a nametag. */
function cleanNametag(raw: string): string {
  const stripped = raw.startsWith('@') ? raw.slice(1) : raw;
  return normalizeNametag(stripped);
}

/**
 * Get current nametag (if registered)
 */
export function getNametagImpl(host: NametagCeremonyHost): string | undefined {
  return host._identity?.nametag;
}

/**
 * Check if nametag is registered
 */
export function hasNametagImpl(host: NametagCeremonyHost): boolean {
  return !!host._identity?.nametag;
}

/**
 * PROXY address caching — retired in Phase 6 (v2 is DIRECT-only).
 *
 * v2's state-transition SDK removed `ProxyAddress` entirely; the wallet
 * exposes only `DIRECT://` addresses now, per token-engine's Path-A
 * architecture. Callers of `getProxyAddress()` still get `undefined`,
 * matching the pre-Phase-6 no-nametag path. Any callsite that WROTE to
 * PROXY:// is broken and will surface in wave 6-P2-5's test migration.
 */
export async function updateCachedProxyAddress(host: NametagCeremonyHost): Promise<void> {
  host._cachedProxyAddress = undefined;
}

/**
 * Mint a nametag token on-chain (like Sphere wallet and lottery).
 * This creates the nametag token required for receiving tokens via PROXY addresses (@nametag).
 */
export async function mintNametagImpl(
  host: NametagCeremonyHost,
  nametag: string,
): Promise<MintNametagResult> {
  host.ensureReady();
  return host._payments.mintNametag(nametag);
}

/**
 * Check if a nametag is available for minting.
 */
export async function isNametagAvailableImpl(
  host: NametagCeremonyHost,
  nametag: string,
): Promise<boolean> {
  host.ensureReady();
  return host._payments.isNametagAvailable(nametag);
}

/**
 * Register a nametag for the current active address
 * Each address can have its own independent nametag
 *
 * **Publish mode** (issue #42):
 * - `'background'` (default): mint is in-band; the Nostr binding
 *   publish is **fire-and-forget**. `registerNametag` resolves as
 *   soon as the on-chain mint lands and local state is updated;
 *   the relay write runs detached. Publish failures
 *   (`NAMETAG_TAKEN` from the relay, network errors) surface via
 *   the `'nametag:publish-failed'` event with rollback of orphan
 *   mints for deterministic rejections. This is the load-bearing
 *   fix for issue #42: a stalled or flaky relay no longer blocks
 *   `sphere init --nametag` for the full CLI timeout. The relay
 *   binding is re-published by `syncIdentityWithTransport` on
 *   every subsequent wallet load, so missed first attempts are
 *   self-healing.
 * - `'await'`: publish is awaited and a relay rejection
 *   (`NAMETAG_TAKEN`) or network throw fails the call synchronously
 *   with rollback. Use when the caller MUST know about
 *   relay collisions before treating the registration as complete
 *   and is willing to block indefinitely on a slow relay.
 *
 * Why background is the default: the on-chain mint is the load-bearing
 * step (irreversible, gas-spending, ownership-establishing). The Nostr
 * binding is a discoverability cache — `syncIdentityWithTransport`
 * republishes it on every wallet load, so a missed first attempt is
 * self-healing.
 *
 * @example
 * ```ts
 * // Default — fast, fire-and-forget Nostr publish
 * await sphere.registerNametag('alice');
 *
 * // Strict — block until publish succeeds OR is deterministically rejected
 * await sphere.registerNametag('alice', { publishMode: 'await' });
 *
 * // React to background publish failure (e.g. surface a banner in UI)
 * sphere.on('nametag:publish-failed', ({ nametag, reason, rolledBack }) => {
 *   // Show: "@${nametag} claim couldn't reach the relay (${reason})"
 * });
 * ```
 */
export async function registerNametagImpl(
  host: NametagCeremonyHost,
  nametag: string,
  options?: { publishMode?: 'await' | 'background' },
): Promise<void> {
  host.ensureReady();
  const publishMode = options?.publishMode ?? 'background';

  // Normalize and validate nametag format
  const cleanedNametag = cleanNametag(nametag);
  if (!isValidNametag(cleanedNametag)) {
    throw new SphereError('Invalid Unicity ID format. Use lowercase alphanumeric, underscore, or hyphen (3-20 chars), or a valid phone number.', 'VALIDATION_ERROR');
  }

  // Check if current address already has a nametag
  if (host._identity?.nametag) {
    throw new SphereError(`Unicity ID already registered for address ${host._currentAddressIndex}: @${host._identity.nametag}`, 'ALREADY_INITIALIZED');
  }

  // 1. Mint nametag token on-chain FIRST — required so the Nostr
  //    binding we publish is backed by an on-chain token under this
  //    wallet's control. Skip the mint only when a token for THIS
  //    EXACT name is already stored (idempotent re-register). If a
  //    DIFFERENT nametag is stored, throw NAMETAG_CONFLICT: registering
  //    `B` while the wallet's anchor is `A` would publish `@B → me`
  //    but finalize incoming PROXY transfers via the `A` token,
  //    producing the alice-vs-alice-t1 mismatch this guard exists for.
  let mintedFresh = false;
  if (!host._payments.hasNametagNamed(cleanedNametag)) {
    if (host._payments.hasNametag()) {
      const existingName = host._payments.getNametag()!.name;
      throw new SphereError(
        `Cannot register Unicity ID "@${cleanedNametag}" — this wallet ` +
        `already holds an on-chain nametag token for "@${existingName}". ` +
        `A single address binds to a single nametag on-chain; switch to ` +
        `a different HD address (sphere.switchToAddress) and register ` +
        `"@${cleanedNametag}" there, or clear the wallet to start fresh.`,
        'NAMETAG_CONFLICT',
      );
    }
    logger.debug('Sphere', `Minting nametag token for @${cleanedNametag}...`);
    const result = await host.mintNametag(cleanedNametag);
    if (!result.success) {
      throw new SphereError(
        `Failed to mint nametag token: ${result.error}`,
        'AGGREGATOR_ERROR',
      );
    }
    mintedFresh = true;
    logger.debug('Sphere', 'Nametag token minted successfully');
  }

  // Belt-and-braces: defense-in-depth against future regressions in
  // PaymentsModule.mintNametag that report success without persisting
  // the NametagData. The current implementation can't reach here
  // legitimately (mint failure throws above; mint success calls
  // setNametag before returning), so this is a guard for the contract,
  // not for any observed bug.
  if (!host._payments.hasNametagNamed(cleanedNametag)) {
    throw new SphereError(
      `Refusing to publish Nostr binding for "@${cleanedNametag}" — mint ` +
      `reported success but no matching nametag token was persisted to ` +
      `the local store. Indicates a partial-write bug in the mint pipeline.`,
      'AGGREGATOR_ERROR',
    );
  }

  // 2. Publish identity binding with nametag to Nostr.
  //
  //    Two modes:
  //    - 'await' preserves the strict legacy contract: surface a relay
  //      rejection (NAMETAG_TAKEN) synchronously, rollback orphan
  //      mints, fail the whole call. Used when the caller MUST know
  //      about relay collisions before treating the registration as
  //      complete and is willing to block indefinitely.
  //    - 'background' (default, issue #42) is FIRE-AND-FORGET: the
  //      publish is scheduled after local state lands (step 3) and
  //      the caller's promise resolves immediately. This decouples
  //      the relay write from the user-visible operation, fixing
  //      the `init --nametag` stall that motivated the issue.
  //      Failures surface via the `'nametag:publish-failed'` event;
  //      see `_handleDetachedPublishOutcome` for the detail.
  if (publishMode === 'await') {
    if (host._transport.publishIdentityBinding) {
      const success = await host._transport.publishIdentityBinding(
        host._identity!.chainPubkey,
        host._identity!.directAddress || '',
        cleanedNametag,
      );
      if (!success) {
        await rollbackOrphanNametagMint(host, cleanedNametag, mintedFresh);
        const restoredSuffix = mintedFresh
          ? ` The orphan local nametag entry from THIS attempt has been rolled back.`
          : ``;
        throw new SphereError(
          `Cannot claim Unicity ID "@${cleanedNametag}" on the relay — the binding ` +
          `event was rejected. Most commonly this means another wallet already ` +
          `owns "@${cleanedNametag}" on this relay (the relay enforces uniqueness ` +
          `independently of the aggregator).${restoredSuffix} Retry with a ` +
          `different --nametag, or contact relay ops if you expected to own this name.`,
          'NAMETAG_TAKEN',
        );
      }
    }
  }

  // 3. Update local state. In `await` mode, we reach this point only
  //    after the publish succeeded. In `background` mode, we reach
  //    this point AS SOON AS the on-chain mint succeeded — the relay
  //    publish runs detached below (step 4) and feeds
  //    `nametag:publish-failed` on failure.
  host._identity!.nametag = cleanedNametag;
  await updateCachedProxyAddress(host);

  // Update nametag cache
  const currentAddressId = host._trackedAddresses.get(host._currentAddressIndex)?.addressId;
  if (currentAddressId) {
    let nametags = host._addressNametags.get(currentAddressId);
    if (!nametags) {
      nametags = new Map();
      host._addressNametags.set(currentAddressId, nametags);
    }
    nametags.set(0, cleanedNametag);
  }

  // Persist nametag cache.
  //
  // In `await` mode (legacy): at this point Nostr already advertises
  // @cleanedNametag bound to our pubkey (step 2), so a persistence
  // failure here would leave local-vs-relay inconsistent — the next
  // cold load() would not see the nametag in local state. Best-
  // effort: catch the persistence failure, log it, but do NOT throw.
  // The relay binding remains authoritative (sync on next
  // switchToAddress / postSwitchSync recovers the nametag via
  // transport lookup).
  //
  // In `background` mode: persistence happens BEFORE the relay
  // publish settles, so a persistence failure means the wallet's
  // local state will be reconstructed from the relay binding on next
  // load. Same best-effort semantics.
  try {
    await host.persistAddressNametags();
  } catch (persistErr) {
    logger.warn(
      'Sphere',
      `registerNametag: local persistence failed for @${cleanedNametag} ` +
        `(${persistErr instanceof Error ? persistErr.message : String(persistErr)}). ` +
        `Next load() will recover via Nostr lookup.`,
    );
  }

  host.emitEvent('nametag:registered', {
    nametag: cleanedNametag,
    addressIndex: host._currentAddressIndex,
  });
  logger.debug('Sphere', `Unicity ID registered for address ${host._currentAddressIndex}:`, cleanedNametag);

  // 4. Detached publish (issue #42, `'background'` mode only).
  //
  //    Fire-and-forget — the caller has already gotten the success
  //    they wanted (mint landed, identity reflects the claim).
  //    Publish failures surface via `nametag:publish-failed` so
  //    apps can react. Deterministic rejections (relay says
  //    "taken") roll back the orphan mint pointer in the async
  //    handler so a subsequent register-with-a-different-name
  //    attempt isn't gated by NAMETAG_CONFLICT.
  //
  //    `void` is intentional — we don't re-await this. The promise
  //    is detached from the caller's resolution path.
  //
  //    Snapshot the address context (issue #42 review B1): a
  //    subsequent `switchToAddress(N)` would swap `this._payments`,
  //    `this._currentAddressIndex`, and the live `this._identity`
  //    before the detached handler resumes. The handler must
  //    operate on the address WE MINTED FOR, not whatever address
  //    happens to be active when the publish settles.
  if (publishMode === 'background' && host._transport.publishIdentityBinding) {
    const publishPromise = host._transport.publishIdentityBinding(
      host._identity!.chainPubkey,
      host._identity!.directAddress || '',
      cleanedNametag,
    );
    const ctx: DetachedPublishContext = {
      payments: host._payments,
      addressIndex: host._currentAddressIndex,
      addressId: host._trackedAddresses.get(host._currentAddressIndex)?.addressId,
      identityRef: host._identity,
    };
    void handleDetachedPublishOutcome(
      host,
      cleanedNametag,
      mintedFresh,
      publishPromise,
      ctx,
    );
  }
}

/**
 * Issue #42 — detached-publish observer for the bounded-race branch
 * of `registerNametag`. Attaches to a publish promise that already
 * started in step 2 of `registerNametag` (the in-flight wire
 * operation we couldn't / didn't want to wait for synchronously).
 * Failures are reported via the `nametag:publish-failed` event,
 * never re-thrown.
 *
 * Mirrors the rollback semantics of the `await`-mode failure path:
 * a deterministic `false` return from publish (relay says taken)
 * rolls back the orphan local mint pointer AND clears
 * `_identity.nametag` so a subsequent registration attempt with a
 * different name isn't blocked by NAMETAG_CONFLICT. Transient
 * errors (network / disconnect) do NOT roll back —
 * `syncIdentityWithTransport` republishes on next wallet load.
 *
 * All rollback writes target the {@link DetachedPublishContext}
 * captured at registration time, NOT `this.*` at handler-resume
 * time. This is the fix for the review-B1 race: if the caller
 * issues `switchToAddress(N)` (which swaps `this._payments`,
 * `this._currentAddressIndex`, and `this._identity`) between
 * `registerNametag` returning and the publish settling, the
 * rollback must still affect the address we minted for, not the
 * newly-active address.
 *
 * Destroy guard (review B2): if the wallet has been destroyed
 * since dispatch (`this._initialized === false`), bail out before
 * touching storage that's already been disconnected. The next
 * cold load's `syncIdentityWithTransport` will reconcile.
 */
async function handleDetachedPublishOutcome(
  host: NametagCeremonyHost,
  cleanedNametag: string,
  mintedFresh: boolean,
  publishPromise: Promise<boolean>,
  ctx: DetachedPublishContext,
): Promise<void> {
  try {
    const success = await publishPromise;
    if (success) {
      return;
    }

    // Destroy guard — Sphere has been torn down since the publish
    // dispatched. Storage / transport are disconnected; the
    // rollback's storage writes would silently no-op and the
    // emitted event would land on cleared handler sets. Defer to
    // next cold load.
    if (!host._initialized) {
      return;
    }

    // Relay rejected — treat as `taken` (deterministic, no retry).
    let rolledBack = false;
    if (mintedFresh) {
      try {
        // Use the captured `payments` reference — `this._payments`
        // may have been swapped by a concurrent `switchToAddress`.
        await ctx.payments.clearNametagByName(cleanedNametag);
        rolledBack = true;
        // Clear the in-memory identity claim too — without this,
        // the (possibly still-active) `identityRef` still says the
        // claimed name while the wallet's nametag store has been
        // cleared, an inconsistency that would confuse the next
        // address-switch post-sync. We compare BY VALUE on the
        // captured reference so a switch-then-switch-back round
        // trip that reset `identityRef.nametag` for unrelated
        // reasons doesn't get clobbered.
        if (ctx.identityRef && ctx.identityRef.nametag === cleanedNametag) {
          ctx.identityRef.nametag = undefined;
          // Only refresh the cached proxy address if the captured
          // identity is STILL the active one — otherwise the
          // switchToAddress dance already rebuilt it for the new
          // active address and we'd be overwriting fresh state.
          if (host._identity === ctx.identityRef) {
            await updateCachedProxyAddress(host);
          }
        }
        if (ctx.addressId) {
          const nametagsMap = host._addressNametags.get(ctx.addressId);
          if (nametagsMap?.get(0) === cleanedNametag) {
            nametagsMap.delete(0);
            try {
              await host.persistAddressNametags();
            } catch (persistErr) {
              logger.warn(
                'Sphere',
                `Background publish rollback persistence failed for @${cleanedNametag} (continuing):`,
                persistErr,
              );
            }
          }
        }
        logger.debug(
          'Sphere',
          `Rolled back orphan local nametag entry for "@${cleanedNametag}" (address ${ctx.addressIndex}) after background publish failure`,
        );
      } catch (rollbackErr) {
        logger.warn(
          'Sphere',
          `Failed to roll back nametag "@${cleanedNametag}" after background publish failure (continuing):`,
          rollbackErr,
        );
      }
    }

    // Second destroy-guard pass — the rollback chain awaited file
    // I/O; the wallet may have been torn down during it. Suppress
    // the event so apps don't react to a publish-failure on a
    // wallet they've already destroyed.
    if (!host._initialized) {
      return;
    }

    logger.warn(
      'Sphere',
      `Background publish rejected "@${cleanedNametag}" — relay says the name is taken by another pubkey. ` +
        (rolledBack
          ? `Local mint pointer has been rolled back.`
          : `Local mint pointer was preserved (pre-existing).`),
    );

    host.emitEvent('nametag:publish-failed', {
      nametag: cleanedNametag,
      reason: 'taken',
      rolledBack,
    });
  } catch (err) {
    // Transient (network / disconnect / internal). Do NOT roll back —
    // `syncIdentityWithTransport` will republish on next load and
    // the relay may still accept us. Surface the failure for
    // observability — but suppress if the wallet has been destroyed
    // since dispatch (the throw is most likely the transport tear-
    // down itself).
    if (!host._initialized) {
      return;
    }
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn(
      'Sphere',
      `Background publish for "@${cleanedNametag}" threw (transient — will republish on next load):`,
      errorMsg,
    );
    host.emitEvent('nametag:publish-failed', {
      nametag: cleanedNametag,
      reason: 'error',
      error: errorMsg,
      rolledBack: false,
    });
  }
}

/**
 * Rollback an orphaned mint when synchronous publish fails (the
 * `await`-mode path). Extracted for symmetry with the background-
 * mode rollback logic.
 *
 * Note (review N5): unlike `_handleDetachedPublishOutcome`'s
 * rollback, this helper does NOT touch `_identity.nametag` or
 * `_addressNametags`. That asymmetry is intentional — in `'await'`
 * mode the throw fires in step 2 of `registerNametag`, BEFORE
 * step 3 mutates `_identity.nametag` / `_addressNametags`. The
 * caller's mutations are still local to step 1's mint pointer,
 * so only the mint pointer needs reverting. Don't "fix" this by
 * adding identity-clear logic — that would double-clear nothing
 * (the field was never set on this code path) and could
 * inadvertently regress unrelated state.
 */
async function rollbackOrphanNametagMint(
  host: NametagCeremonyHost,
  cleanedNametag: string,
  mintedFresh: boolean,
): Promise<void> {
  if (!mintedFresh) return;
  try {
    await host._payments.clearNametagByName(cleanedNametag);
    logger.debug(
      'Sphere',
      `Rolled back orphan local nametag entry for "@${cleanedNametag}" after publish failure`,
    );
  } catch (rollbackErr) {
    logger.warn(
      'Sphere',
      `Failed to roll back nametag "@${cleanedNametag}" after publish failure (continuing):`,
      rollbackErr,
    );
  }
}
