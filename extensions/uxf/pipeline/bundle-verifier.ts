/**
 * Bundle verifier — UXF Inter-Wallet Transfer recipient (T.3.A).
 *
 * Implements the four BUNDLE-LEVEL checks of §5.2, run AFTER the bundle
 * acquirer (T.3.A `bundle-acquirer.ts`) has pulled the CAR bytes and
 * passed root-CID consistency. This module is **structural only** — it
 * does NOT verify cryptographic content (per-tx ECDSA, inclusion proofs);
 * those belong to T.3.B.1.
 *
 * The four §5.2 checks (in order):
 *
 *   1. **`pkg.verify()` wrapper** — delegates DAG-integrity checks to the
 *      package verifier at `uxf/verify.ts` (multihash, single-root, root-
 *      CID match, type-tag validity, hash-match on references, cycle-free
 *      DAG, depth/pool caps). Multi-root CARs are caught by
 *      `extractCarRootCid` upstream; here we surface every other failure
 *      as `BUNDLE_REJECTED_VERIFY_FAILED`. The originating
 *      `UxfVerificationIssue[]` rides in `cause` for forensic detail.
 *
 *   2. **Token-id claim consistency** — `payload.tokenIds` is ADVISORY:
 *      every token-root element in the pool is processed (subset, equal,
 *      or superset of the claim). Token-roots not in the claim are NOT
 *      "smuggled in" because §5.3 [B] rejects anything whose current
 *      state doesn't bind to us. This module:
 *        - Categorizes pool roots into CLAIMED (present in
 *          `payload.tokenIds`) vs UNCLAIMED ("advisory" / not claimed).
 *        - Returns both lists to the caller for downstream §5.3 walking.
 *
 *   3. **Chain-depth cap (two-tier rule)** — apply
 *      {@link MAX_CHAIN_DEPTH} per token, with a smuggling defense:
 *        - For every CLAIMED root: if depth > cap, reject the whole
 *          bundle (`BUNDLE_REJECTED_CHAIN_DEPTH_EXCEEDED`). The sender
 *          claimed it; the sender is responsible.
 *        - For every UNCLAIMED root: if depth > cap, SILENTLY DROP that
 *          root from processing. Legitimate claimed tokens still
 *          process normally. Prevents griefing-via-attached-deep-roots.
 *      "Depth" = number of unfinalized transactions in the chain; the
 *      wave-T.3.A receiver can only see the structural transaction count
 *      via the token-root's `transactions[]` length (each tx may or may
 *      not have an inclusionProof — the structural cap simply counts
 *      transactions, the more-conservative choice).
 *
 *   4. **Smuggled-roots count cap (`_audit` DoS defense)** — count every
 *      top-level pool element with type-tag `'token-root'` (or any future
 *      root-equivalent type-tag, see fail-closed rule below) that is NOT
 *      enumerated in `payload.tokenIds`. If the count exceeds
 *      {@link MAX_UNCLAIMED_ROOTS}, reject the whole bundle
 *      (`BUNDLE_REJECTED_UNCLAIMED_ROOT_COUNT_EXCEEDED`).
 *
 *      **Forward-compat (fail-closed)**: any top-level pool element with
 *      a type-tag NOT in our recognized set MUST be counted toward
 *      `MAX_UNCLAIMED_ROOTS`. This treats unrecognized roots as
 *      potentially-smuggled until a future spec rev extends
 *      `ROOT_EQUIVALENT_TYPES`. (Sub-DAG dependencies — predicates, txs,
 *      inclusion proofs — have OTHER known type-tags; they're never
 *      counted as "potentially smuggled roots".)
 *
 * The contract: the verifier returns a {@link VerifiedBundle} on success
 * (structurally OK; per-token ownership / proof checks deferred to §5.3)
 * or throws a typed `SphereError` with a `BUNDLE_REJECTED_*` code.
 *
 * Spec references:
 *   - §5.2 #1 — `pkg.verify()` delegation
 *   - §5.2 #2 — `tokenIds` advisory + claimed/unclaimed split
 *   - §5.2 #3 — chain-depth cap (two-tier rule)
 *   - §5.2 #4 — smuggled-roots count cap (fail-closed type-tags)
 *   - §5.6   — idempotency (replay re-runs §5.2 deterministically)
 *
 * @packageDocumentation
 */

import { SphereError } from '../../../core/errors.js';
import type { UxfTransferPayload } from '../types/uxf-transfer.js';
import type { UxfPackage } from '../bundle/UxfPackage.js';
import {
  ELEMENT_TYPE_TOKEN_ROOT,
  type ContentHash,
  type TokenRootContent,
  type TokenRootChildren,
  type UxfElement,
  type UxfElementType,
} from '../bundle/types.js';

import { MAX_CHAIN_DEPTH, MAX_UNCLAIMED_ROOTS } from './limits.js';

// =============================================================================
// 1. Public types
// =============================================================================

/**
 * Outcome of {@link verifyBundleStructure} on success. The bundle has
 * passed every §5.2 structural check; per-token ownership and crypto
 * verification (§5.3 [B]/[C]) is the caller's job.
 */
export interface VerifiedBundle {
  /** Discriminator for downstream type narrowing. */
  readonly verified: true;
  /** The underlying package wrapper. Re-exposed so the caller doesn't
   *  need to keep the original reference. */
  readonly pkg: UxfPackage;
  /** The bundleCid the acquirer extracted (and confirmed against
   *  `payload.bundleCid`). */
  readonly bundleCid: string;
  /**
   * Token-roots whose `tokenId` appears in `payload.tokenIds`. These
   * are the SENDER's claimed targets — §5.3 walks them in order and
   * applies the disposition matrix.
   *
   * Each entry includes the root element's content hash (the pool key)
   * and the parsed `tokenId`. Order matches `payload.tokenIds` insofar
   * as tokens were found in the pool; entries claimed but missing from
   * the pool are NOT in this list (see {@link missingClaimedTokenIds}).
   */
  readonly claimedTokens: ReadonlyArray<RootRef>;
  /**
   * Token-roots present in the pool but NOT enumerated in
   * `payload.tokenIds`. Per §5.2 #2, these are processed normally
   * (advisory `tokenIds` semantic) and filtered for ownership at §5.3
   * [B]. Roots dropped due to chain-depth > cap are NOT in this list
   * (silent drop per §5.2 #3).
   */
  readonly advisoryUnclaimedRoots: ReadonlyArray<RootRef>;
  /**
   * Subset of `payload.tokenIds` that the verifier could not locate in
   * the pool. Per §5.2 #2 the recipient still proceeds — the sender's
   * claim is advisory. Surfaced for telemetry; downstream consumers
   * MAY log a warning. Empty in the honest case.
   */
  readonly missingClaimedTokenIds: ReadonlyArray<string>;
  /**
   * Number of unclaimed/unrecognized root candidates we silently dropped
   * for exceeding the chain-depth cap (§5.2 #3 second tier). For
   * telemetry / metrics.
   */
  readonly droppedDeepUnclaimed: number;
}

/**
 * A pool reference to a token-root element, with the parsed `tokenId`
 * extracted from its `content`.
 */
export interface RootRef {
  /** The pool key (content hash) of the token-root element. */
  readonly contentHash: ContentHash;
  /** The token's logical id (lowercase hex per the canonical model). */
  readonly tokenId: string;
  /** Number of transactions in the chain (proxy for "chain depth"). */
  readonly chainDepth: number;
}

// =============================================================================
// 2. Internal — recognized top-level element types (fail-closed §5.2 #4)
// =============================================================================

/**
 * The set of element type-tags considered "root-equivalent" for the
 * smuggled-roots cap. Today only `'token-root'`. Future schema
 * revisions adding new root-bearing top-level elements MUST extend this
 * set in lockstep across implementations — out-of-lockstep extensions
 * cause honest senders to be rejected as "smuggling" (per the spec's
 * §5.2 #4 fail-closed paragraph).
 *
 * @internal
 */
const ROOT_EQUIVALENT_TYPES: ReadonlySet<string> = new Set([ELEMENT_TYPE_TOKEN_ROOT]);

/**
 * The full set of element type-tags we recognize as legitimate sub-DAG
 * dependencies. Used to distinguish "unknown type-tag at top level"
 * (counts toward the smuggled-roots cap, fail-closed) from "recognized
 * non-root sub-element" (does not count).
 *
 * @internal
 */
const KNOWN_ELEMENT_TYPES: ReadonlySet<string> = new Set<UxfElementType>([
  'token-root',
  'genesis',
  'genesis-data',
  'transaction',
  'transaction-data',
  'inclusion-proof',
  'authenticator',
  'unicity-certificate',
  'predicate',
  'token-state',
  'token-coin-data',
  'smt-path',
]);

// =============================================================================
// 3. Public API — verifyBundleStructure
// =============================================================================

/**
 * Run every §5.2 BUNDLE-LEVEL check on `pkg` against `payload`. On
 * success returns a {@link VerifiedBundle}; on any rejection throws a
 * typed {@link SphereError} with a `BUNDLE_REJECTED_*` code.
 *
 * @param pkg          The deserialized UXF package (from
 *                     `UxfPackage.fromCar`).
 * @param payload      The decoded transfer envelope. The verifier reads
 *                     `payload.tokenIds` and `payload.bundleCid` only;
 *                     other fields are advisory / unauthenticated.
 * @param bundleCid    The CIDv1 base32 we extracted from the CAR bytes.
 *                     The acquirer (T.3.A) has already cross-checked
 *                     this against `payload.bundleCid`; we re-thread it
 *                     into the result for the caller's convenience.
 *
 * @throws {SphereError} `BUNDLE_REJECTED_VERIFY_FAILED` if `pkg.verify()`
 *         reports any structural error.
 * @throws {SphereError} `BUNDLE_REJECTED_CHAIN_DEPTH_EXCEEDED` if any
 *         CLAIMED token has `chainDepth > MAX_CHAIN_DEPTH`.
 * @throws {SphereError} `BUNDLE_REJECTED_UNCLAIMED_ROOT_COUNT_EXCEEDED`
 *         if the bundle's pool carries more than
 *         {@link MAX_UNCLAIMED_ROOTS} non-claimed roots (including any
 *         top-level elements with unrecognized type-tags — fail-closed).
 */
export function verifyBundleStructure(
  pkg: UxfPackage,
  payload: UxfTransferPayload,
  bundleCid: string,
): VerifiedBundle {
  // ---- §5.2 #1 — pkg.verify() ----
  const verifyResult = pkg.verify();
  if (!verifyResult.valid) {
    // Build a concise message; pass the issues array as `cause` so any
    // forensic / telemetry layer can inspect them (Sentry, util.inspect,
    // structured logging frameworks all walk `err.cause`).
    const summary = verifyResult.errors.slice(0, 3).map((e) => `${e.code}: ${e.message}`).join('; ');
    throw new SphereError(
      `verifyBundleStructure: pkg.verify() failed: ${summary}` +
        (verifyResult.errors.length > 3 ? ` (+${verifyResult.errors.length - 3} more)` : ''),
      'BUNDLE_REJECTED_VERIFY_FAILED',
      verifyResult.errors,
    );
  }

  // ---- §5.2 #4 — smuggled-roots count cap (fail-closed type-tag handling) ----
  //
  // We must run this BEFORE walking #3's two-tier chain-depth rule
  // because #4 may alone reject the whole bundle, and we want a clean
  // O(N) pass rather than mixing concerns.
  //
  // The cap counts:
  //   - every pool element whose type ∈ ROOT_EQUIVALENT_TYPES that is
  //     NOT in `payload.tokenIds`, AND
  //   - every pool element whose type is UNRECOGNIZED (not in
  //     KNOWN_ELEMENT_TYPES) — fail-closed treatment.
  //
  // Sub-DAG dependencies (predicates, transactions, ...) are NOT
  // counted because their types are recognized and not root-equivalent.

  const claimedTokenIdSet = buildClaimedTokenIdSet(payload);
  const pool = pkg.packageData.pool;

  // Walk the pool ONCE: collect candidate roots (root-equivalent + unknown
  // top-level types) along the way, classify into claimed/unclaimed, and
  // count for the smuggled-roots cap.
  const claimedRoots: RootRef[] = [];
  const unclaimedRootsRaw: RootRef[] = [];
  let unknownTypeCount = 0;

  for (const [hash, element] of pool) {
    if (ROOT_EQUIVALENT_TYPES.has(element.type)) {
      const ref = parseTokenRoot(hash, element);
      if (ref === null) {
        // Malformed token-root content (no tokenId, etc.). pkg.verify()
        // should have caught this already — defensive.
        throw new SphereError(
          `verifyBundleStructure: token-root ${hash} has malformed content`,
          'BUNDLE_REJECTED_VERIFY_FAILED',
        );
      }
      if (claimedTokenIdSet.has(ref.tokenId)) {
        claimedRoots.push(ref);
      } else {
        unclaimedRootsRaw.push(ref);
      }
    } else if (!KNOWN_ELEMENT_TYPES.has(element.type)) {
      // Unrecognized type-tag at any level — fail-closed: count as
      // smuggled-root candidate. We do NOT add it to `unclaimedRootsRaw`
      // because we don't know how to walk it for §5.3 purposes; we
      // simply count it for the cap.
      unknownTypeCount++;
    }
    // Recognized non-root sub-DAG elements (predicates, txs, ...) are
    // ignored — they're legitimate dependencies of the roots above.
  }

  // Total smuggled-root candidate count = unclaimed token-roots + unknown
  // top-level types. Apply cap.
  const smuggledRootCount = unclaimedRootsRaw.length + unknownTypeCount;
  if (smuggledRootCount > MAX_UNCLAIMED_ROOTS) {
    throw new SphereError(
      `verifyBundleStructure: ${smuggledRootCount} unclaimed/unknown roots exceeds ` +
        `MAX_UNCLAIMED_ROOTS=${MAX_UNCLAIMED_ROOTS} (bundleCid=${bundleCid})`,
      'BUNDLE_REJECTED_UNCLAIMED_ROOT_COUNT_EXCEEDED',
    );
  }

  // ---- §5.2 #3 — chain-depth cap (two-tier rule) ----
  //
  // Tier 1: any CLAIMED root with chainDepth > cap → reject WHOLE bundle.
  // Tier 2: any UNCLAIMED root with chainDepth > cap → silent drop.

  for (const ref of claimedRoots) {
    if (ref.chainDepth > MAX_CHAIN_DEPTH) {
      throw new SphereError(
        `verifyBundleStructure: claimed token ${ref.tokenId} chain depth ${ref.chainDepth} ` +
          `exceeds MAX_CHAIN_DEPTH=${MAX_CHAIN_DEPTH} (bundleCid=${bundleCid})`,
        'BUNDLE_REJECTED_CHAIN_DEPTH_EXCEEDED',
      );
    }
  }

  const advisoryUnclaimedRoots: RootRef[] = [];
  let droppedDeepUnclaimed = 0;
  for (const ref of unclaimedRootsRaw) {
    if (ref.chainDepth > MAX_CHAIN_DEPTH) {
      // Silent drop per §5.2 #3 tier-2.
      droppedDeepUnclaimed++;
      continue;
    }
    advisoryUnclaimedRoots.push(ref);
  }

  // ---- §5.2 #2 — track missing claimed tokenIds for telemetry ----
  //
  // The recipient still proceeds; we just surface the gap so callers
  // can log it. Honest case: empty list. Legacy payloads have no
  // `tokenIds` field — defensive read mirrors `buildClaimedTokenIdSet`.
  const foundClaimedIds = new Set(claimedRoots.map((r) => r.tokenId));
  const missingClaimedTokenIds: string[] = [];
  const claimedIdsList =
    (payload as { tokenIds?: readonly string[] }).tokenIds ?? [];
  for (const claimedId of claimedIdsList) {
    if (!foundClaimedIds.has(claimedId)) {
      missingClaimedTokenIds.push(claimedId);
    }
  }

  return {
    verified: true,
    pkg,
    bundleCid,
    claimedTokens: claimedRoots,
    advisoryUnclaimedRoots,
    missingClaimedTokenIds,
    droppedDeepUnclaimed,
  };
}

// =============================================================================
// 4. Internal helpers
// =============================================================================

/**
 * Build the lookup set of claimed tokenIds from `payload`. Legacy
 * payloads (no `tokenIds`) yield an empty set, in which case ALL
 * pool roots are unclaimed — a documented edge case in T.3.A's risk
 * register that drives the smuggled-roots cap to fire when N > 16.
 *
 * @internal
 */
function buildClaimedTokenIdSet(payload: UxfTransferPayload): ReadonlySet<string> {
  // `tokenIds` lives on the UXF v1.0 envelope; legacy shapes don't have
  // it. The runtime guards in `types/uxf-transfer.ts` always populate it
  // for `kind ∈ {'uxf-car','uxf-cid'}`. Defensive read for legacy.
  const ids = (payload as { tokenIds?: readonly string[] }).tokenIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    return new Set();
  }
  return new Set(ids);
}

/**
 * Parse a `token-root` element into a {@link RootRef}. Returns `null`
 * if the element's content/children fail structural shape (no `tokenId`,
 * non-array `transactions`, etc.) — `pkg.verify()` should have caught
 * these already, so a `null` return here indicates a corrupt package
 * that slipped through.
 *
 * @internal
 */
function parseTokenRoot(hash: ContentHash, element: UxfElement): RootRef | null {
  if (element.type !== ELEMENT_TYPE_TOKEN_ROOT) return null;
  const content = element.content as Partial<TokenRootContent>;
  const tokenId = content.tokenId;
  if (typeof tokenId !== 'string' || tokenId.length === 0) return null;

  const children = element.children as Partial<TokenRootChildren>;
  const transactions = children.transactions;
  if (!Array.isArray(transactions)) return null;

  return {
    contentHash: hash,
    tokenId,
    chainDepth: transactions.length,
  };
}
