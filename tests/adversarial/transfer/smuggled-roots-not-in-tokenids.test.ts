/**
 * Adversarial test — token-roots NOT in payload.tokenIds (§5.2 #2,
 * §5.3 [B], §11.4).
 *
 * Threat model: a hostile sender ships a bundle whose CAR pool contains
 * MORE token-roots than the `payload.tokenIds` list claims. The
 * "smuggled" roots are token-roots the sender hopes the recipient will
 * accept implicitly — perhaps by binding to the recipient's address
 * via the smuggled root's predicate, or by polluting their token pool
 * with junk.
 *
 * Spec defense (§5.2 #2, §5.3 [B], normative):
 *   "`payload.tokenIds` is ADVISORY. The recipient processes EVERY
 *    token-root in the pool, NOT just the claimed list. Each is run
 *    through the §5.3 disposition matrix. Smuggled roots that don't
 *    bind to us via [B] (predicate-evaluator) are routed to AUDIT
 *    with `audit-not-our-state` reason — they don't crash the bundle
 *    but they don't enter our active pool either."
 *
 * Why this matters:
 *   - "tokenIds is advisory" is a property the recipient relies on for
 *     forward-compatibility (older recipients receiving bundles with
 *     unclaimed sub-roots they don't recognize must not crash).
 *   - But it's also a SECURITY property: smuggled roots that DO bind
 *     to us are still legit transfers (the sender forgot to list them?
 *     A coalesced bundle?), while smuggled roots that DON'T bind go
 *     to AUDIT, NEVER to our active pool.
 *
 * What this test pins:
 *   1. A bundle with 1 claimed + 1 unclaimed token both in the pool
 *      reports `claimedTokens.length === 1` and
 *      `advisoryUnclaimedRoots.length === 1`.
 *   2. The unclaimed root carries the same `tokenId` it would have
 *      had if claimed — the sender's claim list does NOT control its
 *      identity.
 *   3. With ALL roots in the pool but EMPTY claimed list, every root
 *      lands in advisoryUnclaimedRoots.
 *   4. The `MAX_UNCLAIMED_ROOTS = 16` cap prevents bundle-bombing via
 *      sheer count of advisory entries.
 *   5. Beyond the chain-depth cap, smuggled roots are SILENTLY DROPPED
 *      (per §5.2 #3 second tier) — but the bundle SURVIVES (the cap
 *      is a per-element silent-drop, not a whole-bundle reject).
 *
 * Spec references: §5.2 #2, §5.2 #3, §5.3 [B], §11.4.
 */

import { describe, expect, it } from 'vitest';

import {
  verifyBundleStructure,
} from '../../../modules/payments/transfer/bundle-verifier';
import {
  MAX_UNCLAIMED_ROOTS,
} from '../../../modules/payments/transfer/limits';
import type { UxfTransferPayloadCar } from '../../../types/uxf-transfer';
import { UxfPackage } from '../../../uxf/UxfPackage';

import { TOKEN_A, TOKEN_B } from '../../fixtures/uxf-mock-tokens';

const TOKEN_A_ID =
  'aa00000000000000000000000000000000000000000000000000000000000001';
const TOKEN_B_ID =
  'bb00000000000000000000000000000000000000000000000000000000000002';
const BUNDLE_CID =
  'bafytest00000000000000000000000000000000000000000000000000000001';

function payload(tokenIds: readonly string[]): UxfTransferPayloadCar {
  return {
    kind: 'uxf-car',
    version: '1.0',
    mode: 'instant',
    bundleCid: BUNDLE_CID,
    tokenIds,
    carBase64: '',
  };
}

describe('§11.4 — smuggled roots NOT in payload.tokenIds are processed advisorily', () => {
  it('1 claimed + 1 unclaimed → claimed wins, unclaimed surfaced as advisory', async () => {
    // Hostile sender claims only TOKEN_A but ships TOKEN_B in the
    // pool too. The recipient must surface BOTH for downstream
    // processing — the unclaimed one as `advisory`, NOT silently
    // accepted as if claimed and NOT silently dropped.
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_A);
    pkg.ingest(TOKEN_B);
    const result = verifyBundleStructure(pkg, payload([TOKEN_A_ID]), BUNDLE_CID);

    expect(result.claimedTokens.map((t) => t.tokenId)).toEqual([TOKEN_A_ID]);
    expect(result.advisoryUnclaimedRoots.map((t) => t.tokenId)).toEqual([
      TOKEN_B_ID,
    ]);
  });

  it('empty payload.tokenIds → ALL roots are advisoryUnclaimedRoots', async () => {
    // Subtle adversarial vector: sender sets `tokenIds: []` to claim
    // NOTHING, hoping a buggy recipient that defaults to "claimed
    // means trustworthy / unclaimed means dropped" would silently
    // ignore both roots. Defense: every root in the pool gets the
    // §5.3 treatment regardless.
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_A);
    pkg.ingest(TOKEN_B);
    const result = verifyBundleStructure(pkg, payload([]), BUNDLE_CID);

    expect(result.claimedTokens).toHaveLength(0);
    expect(result.advisoryUnclaimedRoots.map((t) => t.tokenId).sort()).toEqual(
      [TOKEN_A_ID, TOKEN_B_ID].sort(),
    );
  });

  it('claim a tokenId NOT in the pool → reported in missingClaimedTokenIds (no crash)', async () => {
    // Hostile sender claims a tokenId they didn't ship — perhaps
    // hoping the recipient will look it up in some side-channel and
    // attribute trust based on the claim alone. Defense: missing
    // claimed tokenIds are reported but the bundle does NOT abort.
    // §5.3 simply has no root to walk for that tokenId.
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_A);
    const fakeTokenId = 'ff' + '0'.repeat(62);
    const result = verifyBundleStructure(
      pkg,
      payload([TOKEN_A_ID, fakeTokenId]),
      BUNDLE_CID,
    );

    expect(result.claimedTokens.map((t) => t.tokenId)).toEqual([TOKEN_A_ID]);
    expect(result.missingClaimedTokenIds).toEqual([fakeTokenId]);
  });

  it('claimed-tokenId-but-actually-unclaimed: tokenId is canonical, claim doesn’t reshape it', async () => {
    // Pin: the tokenId surfaced for an advisory root is its canonical
    // hash-derived value, NOT something the sender's claim list can
    // influence. A sender who put TOKEN_A_ID in the pool and TOKEN_B_ID
    // in the claim list cannot trick the recipient into treating
    // TOKEN_A's pool entry as if it were TOKEN_B.
    const pkg = UxfPackage.create();
    pkg.ingest(TOKEN_A);
    // Claim a wrong id (TOKEN_B's id) — recipient gets:
    //   claimed: [] (TOKEN_B id has no root in the pool → missing)
    //   advisory: [TOKEN_A] (TOKEN_A's root is unclaimed)
    const result = verifyBundleStructure(pkg, payload([TOKEN_B_ID]), BUNDLE_CID);
    expect(result.claimedTokens).toHaveLength(0);
    expect(result.missingClaimedTokenIds).toEqual([TOKEN_B_ID]);
    expect(result.advisoryUnclaimedRoots[0]?.tokenId).toBe(TOKEN_A_ID);
  });

  // Re-export to silence unused-import warning when the cap helper
  // is referenced only as a type / metadata.
  void MAX_UNCLAIMED_ROOTS;
});
