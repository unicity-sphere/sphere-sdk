/**
 * Sphere nametag identity sync / recovery — Wave 6-P2-8 extraction from
 * `core/Sphere.ts`.
 *
 * Two orchestrations moved here:
 *   1. {@link syncIdentityWithTransport} — publish (or re-publish) the
 *      wallet's identity binding to the transport (Nostr), recovering
 *      the nametag from a legacy-format binding event when present.
 *   2. {@link recoverNametagFromTransport} — post-import nametag
 *      recovery. Decrypts the encrypted nametag from an authored
 *      binding event, restores it into local state, and re-mints the
 *      on-chain nametag token so subsequent PROXY-mode transfers can
 *      finalize.
 *
 * Plus the shared {@link cleanNametag} normalizer.
 *
 * Behavior-preserving: bodies moved verbatim behind a
 * `NametagSyncHost` shim. Sphere retains thin private delegators.
 */

import { logger } from './logger';
import type { TransportProvider } from '../transport';
import type { PaymentsModule } from '../modules/payments';
import { normalizeNametag } from '@unicitylabs/nostr-js-sdk';
import type {
  FullIdentity,
  TrackedAddress,
  SphereEventType,
  SphereEventMap,
} from '../types';

/** Mutable version of FullIdentity — matches Sphere's internal alias. */
export type MutableFullIdentity = {
  -readonly [K in keyof FullIdentity]: FullIdentity[K];
};

/**
 * Host shim for the nametag-sync ops. Mirrors the Sphere fields and
 * helpers that the moved methods reach for. `_identity` is mutable —
 * both flows patch `_identity.nametag` in place.
 */
export interface NametagSyncHost {
  readonly _transport: TransportProvider;
  _identity: MutableFullIdentity | null;
  readonly _currentAddressIndex: number;
  readonly _addressNametags: Map<string, Map<number, string>>;
  readonly _payments: PaymentsModule;

  ensureAddressTracked(index: number): Promise<TrackedAddress>;
  persistAddressNametags(): Promise<void>;
  _updateCachedProxyAddress(): Promise<void>;
  emitEvent<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
}

/**
 * Strip @ prefix and normalize a nametag (lowercase, phone E.164,
 * strip @unicity suffix).
 */
export function cleanNametag(raw: string): string {
  const stripped = raw.startsWith('@') ? raw.slice(1) : raw;
  return normalizeNametag(stripped);
}

/**
 * Sync the wallet's identity binding with the transport (Nostr):
 *   1. Query the relay for an existing binding by the wallet's transport
 *      pubkey (chainPubkey without the 02/03 prefix).
 *   2. If a binding exists with a nametag we don't hold locally, recover
 *      it into local state. Legacy-format bindings (which encrypt the
 *      nametag) fall through to `transport.recoverNametag()`.
 *   3. If the existing binding is missing critical fields (directAddress,
 *      chainPubkey, or a locally-held nametag), re-publish with the full
 *      data. Otherwise skip.
 *   4. If no binding exists, publish for the first time.
 */
export async function syncIdentityWithTransport(host: NametagSyncHost): Promise<void> {
  if (!host._transport.publishIdentityBinding) {
    return; // Transport doesn't support identity binding
  }

  try {
    // Check if a binding already exists by querying the relay by transport pubkey
    // (= x-only pubkey = chainPubkey without the 02/03 prefix).
    // This finds events in ANY format (old d=hashedNametag and new d=hash(identity:pubkey))
    // because resolve(64-hex) searches by event author, not by tag.
    const transportPubkey = host._identity?.chainPubkey?.slice(2);
    if (transportPubkey && host._transport.resolve) {
      try {
        const existing = await host._transport.resolve(transportPubkey);
        if (existing) {
          // If existing binding has nametag but local state doesn't — recover it
          let recoveredNametag = existing.nametag;
          let fromLegacy = false;

          // Old-format events don't have content.nametag (only encrypted_nametag).
          // Fall back to recoverNametag() which decrypts encrypted_nametag from any event.
          if (!recoveredNametag && !host._identity?.nametag && host._transport.recoverNametag) {
            try {
              recoveredNametag = await host._transport.recoverNametag() ?? undefined;
              if (recoveredNametag) fromLegacy = true;
            } catch {
              // Decryption failed — continue without nametag
            }
          }

          if (recoveredNametag && !host._identity?.nametag) {
            (host._identity as MutableFullIdentity).nametag = recoveredNametag;
            await host._updateCachedProxyAddress();

            const entry = await host.ensureAddressTracked(host._currentAddressIndex);
            let nametags = host._addressNametags.get(entry.addressId);
            if (!nametags) {
              nametags = new Map();
              host._addressNametags.set(entry.addressId, nametags);
            }
            if (!nametags.has(0)) {
              nametags.set(0, recoveredNametag);
              await host.persistAddressNametags();
            }

            host.emitEvent('nametag:recovered', { nametag: recoveredNametag });

            // Re-publish in new format only when migrating from legacy event
            if (fromLegacy) {
              await host._transport.publishIdentityBinding!(
                host._identity!.chainPubkey,
                host._identity!.directAddress || '',
                recoveredNametag,
              );
              logger.debug('Sphere', `Migrated legacy binding with Unicity ID @${recoveredNametag}`);
              return;
            }
          }

          // Check if existing binding is missing critical fields — re-publish if so
          const needsUpdate =
            !existing.directAddress ||
            !existing.chainPubkey ||
            (host._identity?.nametag && !existing.nametag);

          if (needsUpdate) {
            logger.debug('Sphere', 'Existing binding incomplete, re-publishing with full data');
            await host._transport.publishIdentityBinding!(
              host._identity!.chainPubkey,
              host._identity!.directAddress || '',
              host._identity?.nametag || existing.nametag || undefined,
            );
            return;
          }

          logger.debug('Sphere', 'Existing binding found, skipping re-publish');
          return;
        }
      } catch (e) {
        // resolve failed — do NOT fall through to publish, as it could
        // overwrite an existing binding (with nametag) with one without.
        // Next reload will retry.
        logger.warn('Sphere', 'resolve() failed, skipping publish to avoid overwrite', e);
        return;
      }
    }

    // No existing binding — publish for the first time
    const nametag = host._identity?.nametag;
    const success = await host._transport.publishIdentityBinding(
      host._identity!.chainPubkey,
      host._identity!.directAddress || '',
      nametag || undefined,
    );
    if (success) {
      logger.debug('Sphere', `Identity binding published${nametag ? ` with Unicity ID @${nametag}` : ''}`);
    } else if (nametag) {
      logger.warn('Sphere', `Unicity ID @${nametag} is taken by another pubkey`);
    }
  } catch (error) {
    // Don't fail wallet load on identity sync errors
    logger.warn('Sphere', `Identity binding sync failed:`, error);
  }
}

/**
 * Recover nametag from transport after wallet import.
 * Searches for encrypted nametag events authored by this wallet's pubkey
 * and decrypts them to restore the nametag association.
 */
export async function recoverNametagFromTransport(host: NametagSyncHost): Promise<void> {
  // Skip if already has a nametag
  if (host._identity?.nametag) {
    return;
  }

  let recoveredNametag: string | null = null;

  // Strategy 1: Decrypt nametag from own Nostr binding events (private-key based)
  if (host._transport.recoverNametag) {
    try {
      recoveredNametag = await host._transport.recoverNametag();
    } catch {
      // Non-fatal — try fallback
    }
  }

  if (!recoveredNametag) {
    return;
  }

  try {
    // Update identity with recovered nametag
    if (host._identity) {
      (host._identity as MutableFullIdentity).nametag = recoveredNametag;
      await host._updateCachedProxyAddress();
    }

    // Update nametag cache
    const entry = await host.ensureAddressTracked(host._currentAddressIndex);
    let nametags = host._addressNametags.get(entry.addressId);
    if (!nametags) {
      nametags = new Map();
      host._addressNametags.set(entry.addressId, nametags);
    }
    const nextIndex = nametags.size;
    nametags.set(nextIndex, recoveredNametag);
    await host.persistAddressNametags();

    // Note: no need to re-publish here — callers follow up with
    // syncIdentityWithTransport() which will publish WITH the recovered nametag.

    // Re-mint the on-chain nametag TOKEN. Without this, the wallet's
    // identity claim (set above) advertises @recoveredNametag on Nostr,
    // but `_payments.nametags` is empty — so the wallet has no
    // `nametagToken.id` to derive the expected PROXY against, and every
    // inbound PROXY-mode transfer fails `finalizeTransferToken` with
    // "Cannot finalize PROXY transfer - no Unicity ID token".
    //
    // Recovery is one deterministic-salt mint call. The aggregator
    // returns `REQUEST_ID_EXISTS` with the original inclusion proof
    // (because the salt is `SHA256(this.signingKey || name)` — same
    // wallet, same name → same commitment ID), and the wallet
    // reconstructs the token locally. No extra round-trip beyond what
    // a fresh mint would cost.
    //
    // If the mint fails (network hiccup, aggregator down, or — in the
    // hypothetical Nostr-binding-forged scenario — the salt doesn't
    // match a prior commitment under this pubkey), we keep the
    // identity claim but warn. PROXY-mode transfers will fail until a
    // subsequent successful `sphere.mintNametag()` call; the operator
    // can retry manually.
    if (!host._payments.hasNametagNamed(recoveredNametag)) {
      try {
        // Call PaymentsModule.mintNametag directly, NOT this.mintNametag.
        // The public Sphere.mintNametag wrapper invokes ensureReady() —
        // which throws "Sphere not initialized" because Sphere.create
        // calls recoverNametagFromTransport BEFORE setting
        // `_initialized = true`. The PaymentsModule's own
        // ensureInitialized() check is satisfied at this point
        // (initializeModules ran earlier in the create flow).
        const mintResult = await host._payments.mintNametag(recoveredNametag);
        if (mintResult.success) {
          logger.debug(
            'Sphere',
            `Re-minted on-chain nametag token for recovered "@${recoveredNametag}"`,
          );
        } else {
          logger.warn(
            'Sphere',
            `Recovered Unicity ID "@${recoveredNametag}" from transport but ` +
            `on-chain token mint-recovery failed: ${mintResult.error}. ` +
            `PROXY-mode inbound transfers will fail until a subsequent ` +
            `sphere.mintNametag("${recoveredNametag}") call succeeds.`,
          );
        }
      } catch (mintErr) {
        logger.warn(
          'Sphere',
          `Recovered Unicity ID "@${recoveredNametag}" from transport but ` +
          `on-chain token mint-recovery threw (continuing without token):`,
          mintErr,
        );
      }
    }

    host.emitEvent('nametag:recovered', { nametag: recoveredNametag });
  } catch {
    // Don't fail wallet import on nametag recovery errors
  }
}
