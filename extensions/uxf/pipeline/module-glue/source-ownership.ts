/**
 * Source-ownership check — Phase 5 [B] extraction from PaymentsModule.ts.
 *
 * Fail-fast predicate check: every source token's current-state
 * predicate must resolve to the wallet's signing key. Catches the
 * Issue #390 recipient-predicate-mismatch pattern before the
 * dispatcher submits any commitment. Extension-bound because the
 * invariant this enforces is a UXF-pipeline concern — the legacy v1
 * dispatcher had a different validation surface.
 *
 * See uxfv2-phase-5-payments-disposition.md §"Source ownership +
 * commitment machinery" for the disposition entry.
 */

import type { Token } from '../../../../types';
import { SphereError } from '../../../../core/errors';
// eslint-disable-next-line no-restricted-imports
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
// eslint-disable-next-line no-restricted-imports
import { PredicateEngineService } from '@unicitylabs/state-transition-sdk/lib/predicate/PredicateEngineService';
// eslint-disable-next-line no-restricted-imports
import type { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';

/**
 * Source-ownership check for `sendConservativeUxf` / `sendInstantUxf`
 * pre-flight. Converts the silent damage from Issue #390 (recipient
 * receives a token whose local current-state predicate is still set
 * to the pre-transfer state, i.e. does not match their signing key
 * yet — spending it would fail deep inside `createSdkCommitment`
 * without cleaning up the reservation) into a loud fail-fast:
 * `OWNERSHIP_VERIFICATION_FAILED`. The outer `send()` catch block
 * cancels the reservation and restores the source tokens to
 * `confirmed`. No on-chain work has happened yet because this check
 * runs BEFORE the split-bundle build and BEFORE the direct
 * commitments are submitted.
 *
 * @throws {SphereError} `OWNERSHIP_VERIFICATION_FAILED` — at least one
 *         source token's current-state predicate does not match the
 *         wallet's signing key.
 */
export async function validateSourceOwnership(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourceTokens: ReadonlyArray<{ uiToken: Token; sdkToken: SdkToken<any> } | Token>,
  signingService: SigningService,
): Promise<void> {
  const publicKey = signingService.publicKey;
  for (const entry of sourceTokens) {
    // Accept both UI Token (with sdkData) and TokenWithAmount-shaped objects
    // {uiToken, sdkToken}. The latter is what splitPlan.tokensToTransferDirectly
    // already has parsed; the former is the splitPlan.tokenToSplit.uiToken
    // before we parse it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sdkToken: SdkToken<any> | null = null;
    let uiTokenId: string;
    if ('sdkToken' in entry) {
      sdkToken = entry.sdkToken;
      uiTokenId = entry.uiToken.id;
    } else {
      const sdkData = entry.sdkData;
      uiTokenId = entry.id;
      if (!sdkData) continue; // not an on-chain spendable token — skip
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sdkToken = await SdkToken.fromJSON(JSON.parse(sdkData) as any) as SdkToken<any>;
      } catch {
        // Unparseable sdkData — let downstream code handle (will throw on
        // commitment construction). Don't fail the pre-check here.
        continue;
      }
    }
    // Defensive: if any of the SDK shape is missing (e.g. mocked-out test
    // doubles), skip — we cannot validate without a real predicate, and
    // letting downstream code run is the existing behaviour for these
    // cases. Production tokens always carry a real predicate.
    if (!sdkToken || !sdkToken.state || !sdkToken.state.predicate) continue;
    let predicate;
    try {
      predicate = await PredicateEngineService.createPredicate(sdkToken.state.predicate);
    } catch {
      // Predicate engine couldn't materialise the predicate — same logic
      // as above; let downstream handle it rather than fail-closing here
      // on a shape we can't reason about.
      continue;
    }
    let owned: boolean;
    try {
      owned = await predicate.isOwner(publicKey);
    } catch {
      // isOwner threw — defer to downstream. We only fail-fast on the
      // EXPLICIT non-ownership case where every SDK call succeeded.
      continue;
    }
    if (!owned) {
      throw new SphereError(
        `Cannot spend token ${uiTokenId.slice(0, 16)}: source state predicate does not match wallet's signing key. ` +
          `The token may be in a stale post-receive state — try sync + receive --finalize, or re-import.`,
        'OWNERSHIP_VERIFICATION_FAILED',
      );
    }
  }
}
