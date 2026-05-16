/**
 * §5.2 #2 — advisory tokenIds POSITIVE test (W24).
 *
 * The §5.2 #2 spec paragraph documents that `payload.tokenIds` is
 * ADVISORY: the recipient MUST process every token-root element in
 * the pool, regardless of whether the sender enumerated it in the
 * outer envelope. Token-roots not enumerated are NOT "smuggled" — they
 * are still subject to the §5.3 [B] ownership filter, which is the
 * actual security gate.
 *
 * The W24 test pins the POSITIVE case: an UNCLAIMED root that
 * structurally binds to the recipient's identity is processed normally
 * (returned in `advisoryUnclaimedRoots`) so the downstream §5.3 walker
 * can credit it to the recipient. This is the protocol's "found money"
 * flow — a sender forwards a bundle that happens to include a token
 * whose current state binds to the recipient even though the sender
 * didn't deliberately claim it.
 *
 * The §5.3 ownership-binding gate ([B]) is downstream of T.3.A — this
 * test exercises ONLY the bundle-verifier's responsibility: pass the
 * unclaimed root through to the caller. Cryptographic validation that
 * "binds to recipient" is the disposition engine's job (T.3.B.2).
 *
 * Spec references:
 *  - §5.2 #2 advisory tokenIds.
 *  - §5.3 [B] last-state predicate target binding (downstream).
 *  - W24 implementation-plan note (T.3.A acceptance).
 */

import { describe, expect, it } from 'vitest';

import { verifyBundleStructure } from '../../../../modules/payments/transfer/bundle-verifier';
import type { UxfTransferPayloadCar } from '../../../../types/uxf-transfer';
import { UxfPackage } from '../../../../uxf/UxfPackage';
import {
  carBytesToBase64,
  extractCarRootCid,
} from '../../../../uxf/transfer-payload';

import { TOKEN_A, TOKEN_B } from '../../../fixtures/uxf-mock-tokens';

const TOKEN_A_ID = 'aa00000000000000000000000000000000000000000000000000000000000001';
const TOKEN_B_ID = 'bb00000000000000000000000000000000000000000000000000000000000002';

describe('§5.2 #2 — advisory tokenIds positive case (W24)', () => {
  it('unclaimed root in bundle is returned in advisoryUnclaimedRoots for downstream §5.3 processing', async () => {
    // Sender ships a bundle containing TOKEN_A and TOKEN_B but
    // claims only TOKEN_A in `payload.tokenIds`. TOKEN_B is the
    // "advisory unclaimed" root — the recipient must still process it.
    const pkg = UxfPackage.create();
    pkg.ingestAll([TOKEN_A, TOKEN_B]);
    const carBytes = await pkg.toCar();
    const bundleCid = await extractCarRootCid(carBytes);

    const payload: UxfTransferPayloadCar = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'instant',
      bundleCid,
      tokenIds: [TOKEN_A_ID], // TOKEN_B intentionally unclaimed
      carBase64: carBytesToBase64(carBytes),
    };

    const result = verifyBundleStructure(pkg, payload, bundleCid);

    // The verifier SHOULD return TOKEN_B in advisoryUnclaimedRoots
    // (positive case) — downstream §5.3 [B] runs ownership binding,
    // and if TOKEN_B's current state binds to the recipient, the
    // disposition engine credits it normally.
    expect(result.verified).toBe(true);
    expect(result.claimedTokens.map((r) => r.tokenId)).toEqual([TOKEN_A_ID]);
    expect(result.advisoryUnclaimedRoots.map((r) => r.tokenId)).toEqual([
      TOKEN_B_ID,
    ]);
    // No silent drops — the unclaimed root has shallow chain depth
    // (well below MAX_CHAIN_DEPTH).
    expect(result.droppedDeepUnclaimed).toBe(0);
    // No claimed tokenIds were missing.
    expect(result.missingClaimedTokenIds).toEqual([]);
  });

  it('all tokens unclaimed (empty tokenIds) — every root passes as advisory', async () => {
    // Edge case: sender forwards a bundle without enumerating any
    // tokenIds. Every root is "advisory unclaimed" — none are
    // smuggled (they all came in via the legitimate UXF pipeline),
    // so the verifier must not reject so long as the count is within
    // MAX_UNCLAIMED_ROOTS.
    const pkg = UxfPackage.create();
    pkg.ingestAll([TOKEN_A, TOKEN_B]);
    const carBytes = await pkg.toCar();
    const bundleCid = await extractCarRootCid(carBytes);

    const payload: UxfTransferPayloadCar = {
      kind: 'uxf-car',
      version: '1.0',
      mode: 'instant',
      bundleCid,
      tokenIds: [], // none claimed
      carBase64: carBytesToBase64(carBytes),
    };

    const result = verifyBundleStructure(pkg, payload, bundleCid);
    expect(result.verified).toBe(true);
    expect(result.claimedTokens).toHaveLength(0);
    expect(result.advisoryUnclaimedRoots.map((r) => r.tokenId).sort()).toEqual(
      [TOKEN_A_ID, TOKEN_B_ID].sort(),
    );
  });
});
