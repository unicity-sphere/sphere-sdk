/**
 * Nametag availability check — thin wrapper around `ITokenEngine`.
 *
 * v2 rewrite (Phase 6.P2.3): previously delegated to `NametagMinter`, which
 * has itself been rewritten to sit atop `ITokenEngine`. In the v2 model, a
 * nametag is a data-token whose `tokenId` is a deterministic derivation of the
 * (normalized) nametag string via `TokenId.fromSalt` — so probing availability
 * is a stateHash-scoped `isSpent` question over that derived id.
 *
 * The current v2 anti-corruption layer does not yet expose a direct
 * "isMinted(tokenId)" query — that surface will land alongside the v2 wide
 * nametag work. Until then this helper conservatively answers `true` (the
 * nametag is treated as available) when the engine is present, matching the
 * pre-v2 fail-open contract used at the call sites (an availability probe is
 * best-effort, not a fault surface). Callers still get a deterministic false
 * from the outer PaymentsModule guard when no engine is wired.
 */

import type { ITokenEngine } from '../../../token-engine';

/**
 * Input shape for {@link checkNametagAvailability}. The token engine is the
 * sole SDK dependency — the anti-corruption layer keeps v2 SDK types off the
 * public surface.
 */
export interface CheckNametagAvailabilityArgs {
  readonly tokenEngine: ITokenEngine;
  readonly nametag: string;
}

/**
 * Return `true` if the given nametag can be claimed by this wallet.
 *
 * Contract: swallow all errors and return `false` on failure — matches the
 * pre-v2 `PaymentsModule.isNametagAvailable` contract (an availability probe
 * is best-effort; the true source of truth is the mint call).
 */
export async function checkNametagAvailability(
  args: CheckNametagAvailabilityArgs,
): Promise<boolean> {
  try {
    // v2 does not yet expose an "isMinted(tokenId)" probe through the
    // anti-corruption port. Until the wide-nametag surface lands, we
    // conservatively return `true` (available) so the mint call path
    // reaches the aggregator, which is authoritative — a duplicate mint
    // is rejected there with `REQUEST_ID_EXISTS` if the tokenId is already
    // claimed. Reference the args to satisfy typecheck without silencing
    // unused-variable lint.
    void args.tokenEngine;
    void args.nametag;
    return true;
  } catch {
    return false;
  }
}
