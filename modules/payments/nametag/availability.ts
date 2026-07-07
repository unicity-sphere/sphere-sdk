/**
 * Nametag availability check — thin wrapper around NametagMinter's
 * `isNametagAvailable` probe.
 *
 * Extracted from PaymentsModule.ts:11828–11851 during Phase 5 (uxfv2-refactor-
 * design.md §2.1, uxfv2-phase-5-payments-disposition.md §"Nametag CRUD + mint").
 * Behavior-preserving: same NametagMinter construction + swallow-error contract
 * as the pre-extraction facade method.
 */

import type { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import { NametagMinter } from '../NametagMinter';

/**
 * Input shape for {@link checkNametagAvailability}. Types stay `unknown` for
 * `stateTransitionClient` / `trustBase` because NametagMinter accepts `any`
 * for these — the SDK doesn't export an interface a caller can constrain to.
 */
export interface CheckNametagAvailabilityArgs {
  readonly stateTransitionClient: unknown;
  readonly trustBase: unknown;
  readonly signingService: SigningService;
  readonly nametag: string;
}

/**
 * Return `true` if the given nametag is not yet minted on-chain and can be
 * claimed by this wallet. Swallows all errors and returns `false` in that
 * case — matches `PaymentsModule.isNametagAvailable`'s pre-extraction
 * contract (an availability probe is a best-effort read, not a fault
 * surface).
 */
export async function checkNametagAvailability(
  args: CheckNametagAvailabilityArgs,
): Promise<boolean> {
  try {
    const minter = new NametagMinter({
      stateTransitionClient: args.stateTransitionClient,
      trustBase: args.trustBase,
      signingService: args.signingService,
    });
    return await minter.isNametagAvailable(args.nametag);
  } catch {
    return false;
  }
}
