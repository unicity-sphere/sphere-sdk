/**
 * Immutable public facts about the wallet binding.
 *
 * Holds NO reference to Sphere, so "nothing is read from a destroyed Sphere while locked"
 * is a property of the types rather than of code review.
 *
 * NOT named SessionSnapshot and carries NO sessionId: it must exist BEFORE any session
 * does — sendHandshakeResponse reads networkId and is the transport for EVERY handshake
 * response, including the refusals.
 *
 * The lock-edge identity binding IS `snapshot.identity?.chainPubkey`; there is no separate
 * chainPubkey field and no separate boundIdentity field.
 */

import type { PublicIdentity } from '../protocol';
import type { SphereInstance } from './SphereInstance';

export interface WalletSnapshot {
  readonly networkId?: number;
  readonly identity?: PublicIdentity;
  /** Epoch ms of capture. 0 means "never captured" — see EMPTY_WALLET_SNAPSHOT. */
  readonly capturedAt: number;
}

/** capturedAt 0, no networkId, no identity. Used for a host built locked with no prior
 *  binding (cold start with an encrypted wallet), after setUnavailable(), and after
 *  destroy(). A handshake against an empty snapshot gets today's empty refusal —
 *  including a resume. "Never invent a fact about a wallet we have not seen." */
export const EMPTY_WALLET_SNAPSHOT: WalletSnapshot = Object.freeze({ capturedAt: 0 });

/**
 * Build from a bound Sphere. `null` returns EMPTY_WALLET_SNAPSHOT.
 *
 * If sphere.identity is null the snapshot has NO identity, and sphere_getIdentity while
 * locked answers 4009 rather than undefined-as-success — a dApp reads an `undefined`
 * success result as "the wallet has no identity".
 */
export function buildWalletSnapshot(sphere: SphereInstance | null): WalletSnapshot {
  if (!sphere) return EMPTY_WALLET_SNAPSHOT;
  const id = sphere.identity;
  return Object.freeze({
    ...(typeof sphere.networkId === 'number' ? { networkId: sphere.networkId } : {}),
    ...(id
      ? {
          identity: Object.freeze({
            chainPubkey: id.chainPubkey,
            directAddress: id.directAddress,
            nametag: id.nametag,
          }),
        }
      : {}),
    capturedAt: Date.now(),
  });
}
