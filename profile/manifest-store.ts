/**
 * UXF Inter-Wallet Transfer — ManifestStore (T.3.C)
 *
 * Typed wrapper over the active-pool manifest reads/writes. Preserves the
 * §5.4 metadata-preservation rules (`audit_promoted_from`, `splitParent`,
 * `conflictingHeads[]`, `lamport`) on every merge, and uses
 * {@link ManifestCas} (T.1.F) for compare-and-swap with bounded retries
 * against concurrent OrbitDB writes.
 *
 * **What this module owns**
 *  - Read existing entry, merge per §5.4, write via CAS, retry on
 *    `cas-mismatch` / `concurrent-modification`.
 *  - Pure {@link mergeManifestEntry} helper exposed for unit tests and
 *    for the §5.3 [D] conflict merger (T.3.D).
 *
 * **What this module does NOT own**
 *  - Routing dispositions to `_invalid` / `_audit` collections — that
 *    lives in {@link DispositionWriter} (`profile/disposition-writer.ts`).
 *  - Deciding whether two heads are conflicting — that lives in the
 *    §5.3 [D] decision matrix walker (T.3.B.2 / T.3.D).
 *  - Lamport clock instantiation — the store consumes a {@link Lamport}
 *    instance supplied by the constructor; per-Sphere lifecycle is the
 *    caller's responsibility.
 *
 * **CAS retry policy** (per §5.5 step 9): on `cas-mismatch` the store
 * re-reads the latest entry, re-runs {@link mergeManifestEntry} against
 * it, and retries. On `concurrent-modification` (the storage backend
 * detected a race after the read but before the write committed), the
 * store also retries. Bounded at {@link CAS_MAX_RETRIES} = 3 to prevent
 * livelock under pathological contention; on exhaustion the store
 * throws `'MANIFEST_CAS_RETRY_EXHAUSTED'`. Inter-retry delay is a
 * deterministic 0ms (no backoff) — the bounded retry count is the only
 * defense the protocol promises here; a pathological hot-key contention
 * is surfaced to the caller for routing, not retried indefinitely.
 *
 * @module profile/manifest-store
 *
 * @see UXF-TRANSFER-PROTOCOL §5.4 (metadata-preservation rules)
 * @see UXF-TRANSFER-PROTOCOL §5.5 step 9 (CAS path)
 * @see UXF-TRANSFER-PROTOCOL §7.1 (Lamport invariants)
 * @see PROFILE-ARCHITECTURE §10.11 (ManifestEntry shape)
 */

import { SphereError } from '../core/errors.js';
import { compareCidV1Binary } from '../modules/payments/transfer/limits.js';
import type { ContentHash } from '../uxf/types.js';
import { Lamport } from './lamport.js';
import {
  ManifestCas,
  type ManifestCasResult,
  type MinimalManifestStorage,
} from './manifest-cas.js';
import type { TokenManifestEntry } from './token-manifest.js';

// =============================================================================
// 1. Public types
// =============================================================================

/**
 * Bounded retry count for CAS races. The §5.5 step 9 path reads, merges,
 * writes — three trips through the loop is enough to absorb a reasonable
 * burst of concurrent writes (e.g. two devices flushing the same token at
 * the same moment) without tipping into livelock.
 */
export const CAS_MAX_RETRIES = 3;

/**
 * Construction options for {@link ManifestStore}.
 */
export interface ManifestStoreOptions {
  /** Storage backend (the OrbitDB-adapter view of the manifest). */
  readonly storage: MinimalManifestStorage;
  /** Per-Sphere Lamport clock used for §7.1 monotonic merges. */
  readonly lamport: Lamport;
  /**
   * Optional pre-constructed CAS helper. Default: a fresh
   * {@link ManifestCas} bound to `storage`. Tests may inject a custom
   * CAS to mock specific failure modes.
   */
  readonly cas?: ManifestCas;
  /** CAS retry budget (default {@link CAS_MAX_RETRIES}). */
  readonly maxRetries?: number;
}

// =============================================================================
// 2. mergeManifestEntry — §5.4 metadata-preservation rules (pure)
// =============================================================================

/**
 * Merge a `next` (incoming, in-flight) manifest entry against a `prev`
 * (already-persisted) entry per §5.4 normative metadata-preservation
 * rules. Pure / deterministic — no side effects, no clock mutation.
 *
 * **Field merge semantics** (per §5.4):
 *  - `rootHash` — taken from `next` when `prev.rootHash === next.rootHash`
 *    (canonical path: conflict-merger stamped the winner as `next`). On
 *    divergence, defense-in-depth symmetric tie-break: lex-min
 *    `bundleCid` if either side carries it; lex-min `rootHash` otherwise.
 *    Ensures `mergeManifestEntry(A, B) === mergeManifestEntry(B, A)`
 *    even if a future caller bypasses `conflict-merger` (T.3.D).
 *  - `status`   — taken from the chain-content winner (per the rootHash
 *    selection above). When rootHashes match, that's `next`.
 *  - `invalidReason` — preserved if either side has it set; on
 *    divergence, prefer `next` (the latest signal).
 *  - `splitParent` — preserved if either side has it set. On
 *    divergence, log warning (defect: a token cannot have two parents)
 *    and use the lex-min value (deterministic across replicas).
 *  - `audit_promoted_from` — set-OR (deduplicated, lex-sorted union).
 *  - `conflictingHeads` — set-OR (deduplicated, sorted union).
 *  - `lamport` — `max(prev, next)` per §7.1.
 *  - `lastProofRefreshAt` — `max(prev, next)` (most-recent-proof rule
 *    per §6.3; prefer the side with fresher proof material).
 *  - `bundleCid` / `senderTransportPubkey` — taken from the
 *    chain-winning side (i.e., `next`); preserved when `next` lacks
 *    them.
 *
 * @param prev The currently-persisted entry, or `undefined` for first write.
 * @param next The new entry to fold in.
 * @param compareCidsBinary Comparator for lex-min tie-break of
 *   conflicting bundleCids. Defaults to {@link compareCidV1Binary} —
 *   tests inject deterministic stubs.
 * @returns The merged entry. Never mutates `prev` or `next`.
 */
export function mergeManifestEntry(
  prev: TokenManifestEntry | undefined,
  next: TokenManifestEntry,
  compareCidsBinary: (a: string, b: string) => -1 | 0 | 1 = compareCidV1Binary,
): TokenManifestEntry {
  if (prev === undefined) {
    // First write: passthrough. Caller is responsible for ensuring
    // `next.lamport` was bumped before calling — we do NOT bump here.
    return next;
  }

  // ---------------------------------------------------------------------------
  // Set-OR merges (audit_promoted_from, conflictingHeads)
  // ---------------------------------------------------------------------------
  const auditPromotedFrom = unionStringArray(
    prev.audit_promoted_from,
    next.audit_promoted_from,
  );
  const conflictingHeads = unionContentHashArray(
    prev.conflictingHeads,
    next.conflictingHeads,
  );

  // ---------------------------------------------------------------------------
  // Max-merges (lamport, lastProofRefreshAt)
  // ---------------------------------------------------------------------------
  const lamport = maxOpt(prev.lamport, next.lamport);
  const lastProofRefreshAt = maxOpt(
    prev.lastProofRefreshAt,
    next.lastProofRefreshAt,
  );

  // ---------------------------------------------------------------------------
  // splitParent — preserved-if-set with lex-min tie-break on divergence
  // ---------------------------------------------------------------------------
  let splitParent: string | undefined;
  if (prev.splitParent === undefined) {
    splitParent = next.splitParent;
  } else if (next.splitParent === undefined) {
    splitParent = prev.splitParent;
  } else if (prev.splitParent === next.splitParent) {
    splitParent = prev.splitParent;
  } else {
    // Defect: divergent splitParent values. Both children claim the
    // same coin token had two different parents, which violates the
    // §6.1.1 cascade invariant (one token has at most one
    // splitParent). Deterministic resolution: lex-min — every replica
    // converges to the same value. Operators can audit via the
    // forensic `_invalid` records on the parents.
    splitParent =
      prev.splitParent < next.splitParent ? prev.splitParent : next.splitParent;
  }

  // ---------------------------------------------------------------------------
  // Chain-content fields — symmetric defense-in-depth tie-break on divergence.
  //
  // **Canonical path**: the §5.3 [D-conflict] tie-break (lex-min bundleCid) is
  // performed UPSTREAM by the conflict merger (T.3.D) when picking which side's
  // chain-content wins. The merger has richer logic (chain-prefix detection,
  // delta direction, etc.) and stamps the winner as `next`. By the time
  // `mergeManifestEntry` sees a stamped `next`, that decision has been made.
  //
  // **Fallback path** (this block): when `prev.rootHash !== next.rootHash`,
  // re-merge symmetrically so `mergeManifestEntry(A, B) === mergeManifestEntry(B, A)`
  // even if a future caller bypasses `conflict-merger`. Without this, replicas
  // could flip-flop the persisted `rootHash` between two values and never
  // converge. See steelman post-cutover review of T.3.C / T.3.D contract.
  //
  // The `compareCidsBinary` arg is the SAME comparator §5.3 [D-conflict] uses
  // (`compareCidV1Binary`); tests inject a deterministic stub. The comparator
  // is invoked via `safeCompareSymmetric` which falls back to plain string
  // compare on parse failure (legacy hex rootHash, malformed bundleCid) — still
  // symmetric, still deterministic across replicas.
  // ---------------------------------------------------------------------------
  const chainSrc: TokenManifestEntry =
    prev.rootHash === next.rootHash
      ? next
      : pickChainWinnerSymmetric(prev, next, compareCidsBinary);
  const otherSrc: TokenManifestEntry = chainSrc === next ? prev : next;

  const rootHash: ContentHash = chainSrc.rootHash;
  const status = chainSrc.status;
  const invalidReason = chainSrc.invalidReason ?? otherSrc.invalidReason;

  // bundleCid / senderTransportPubkey: take from the chain winner; fall back
  // to the other side if the winner did not stamp them.
  const bundleCid = chainSrc.bundleCid ?? otherSrc.bundleCid;
  const senderTransportPubkey =
    chainSrc.senderTransportPubkey ?? otherSrc.senderTransportPubkey;

  // ---------------------------------------------------------------------------
  // Operator-override audit trail (T.5.D — W30 / W31 / N4)
  //
  //   - `overrideApplied`     — set-OR (§7.1 stickiness; mirrors the outbox
  //                             `overrideApplied` semantics).
  //   - `overrideAppliedAt`   — max-merge (most-recent override wins).
  //   - `overrideAppliedBy`   — lex-min when both sides set it (deterministic
  //                             across replicas); preserve-if-set otherwise.
  // ---------------------------------------------------------------------------
  const overrideApplied =
    prev.overrideApplied === true || next.overrideApplied === true
      ? true
      : undefined;
  const overrideAppliedAt = maxOpt(
    prev.overrideAppliedAt,
    next.overrideAppliedAt,
  );
  let overrideAppliedBy: string | undefined;
  if (prev.overrideAppliedBy === undefined) {
    overrideAppliedBy = next.overrideAppliedBy;
  } else if (next.overrideAppliedBy === undefined) {
    overrideAppliedBy = prev.overrideAppliedBy;
  } else if (prev.overrideAppliedBy === next.overrideAppliedBy) {
    overrideAppliedBy = prev.overrideAppliedBy;
  } else {
    overrideAppliedBy =
      prev.overrideAppliedBy < next.overrideAppliedBy
        ? prev.overrideAppliedBy
        : next.overrideAppliedBy;
  }

  // ---------------------------------------------------------------------------
  // Assemble. Omit undefined fields so the on-disk shape stays minimal.
  // ---------------------------------------------------------------------------
  const merged: TokenManifestEntry = stripUndefined({
    rootHash,
    status,
    conflictingHeads,
    invalidReason,
    splitParent,
    audit_promoted_from: auditPromotedFrom,
    lamport,
    lastProofRefreshAt,
    bundleCid,
    senderTransportPubkey,
    overrideApplied,
    overrideAppliedAt,
    overrideAppliedBy,
  });
  return merged;
}

// =============================================================================
// 3. ManifestStore
// =============================================================================

/**
 * Typed wrapper over manifest reads/writes for the active pool.
 *
 * @remarks
 * Holds NO module-level state; all state lives on the instance.
 * Constructing two stores against the same underlying storage is safe —
 * each runs its own retry loop independently, and the CAS primitive
 * absorbs the resulting contention.
 */
export class ManifestStore {
  private readonly storage: MinimalManifestStorage;
  private readonly lamport: Lamport;
  private readonly cas: ManifestCas;
  private readonly maxRetries: number;

  constructor(options: ManifestStoreOptions) {
    if (options.maxRetries !== undefined) {
      if (
        !Number.isFinite(options.maxRetries) ||
        !Number.isInteger(options.maxRetries) ||
        options.maxRetries < 1
      ) {
        throw new SphereError(
          `ManifestStore: maxRetries must be a positive integer, got ${String(options.maxRetries)}`,
          'VALIDATION_ERROR',
        );
      }
    }
    this.storage = options.storage;
    this.lamport = options.lamport;
    this.cas = options.cas ?? new ManifestCas(options.storage);
    this.maxRetries = options.maxRetries ?? CAS_MAX_RETRIES;
  }

  /**
   * Read the current manifest entry for `(addr, tokenId)`. Returns
   * `undefined` if no entry exists yet for this token under this
   * address. Direct passthrough to the storage backend — no caching.
   */
  async readEntry(
    addr: string,
    tokenId: string,
  ): Promise<TokenManifestEntry | undefined> {
    return this.storage.readEntry(addr, tokenId);
  }

  /**
   * Read-merge-CAS-retry upsert of a manifest entry.
   *
   * **Algorithm**
   *   1. Read current entry from storage.
   *   2. Merge `next` against current via {@link mergeManifestEntry}.
   *   3. Bump Lamport via the §7.1 invariant — the bump observes both
   *      the current entry's Lamport (if any) and the `next` Lamport
   *      input (if any).
   *   4. CAS write: precondition is the current entry's `rootHash`
   *      (`null` if no current entry).
   *   5. On `cas-mismatch` / `concurrent-modification`: retry from
   *      step 1, bounded by {@link maxRetries}.
   *
   * @throws SphereError code `MANIFEST_CAS_RETRY_EXHAUSTED` after
   *   `maxRetries` consecutive CAS failures.
   * @throws Re-throws non-CAS storage errors as-is.
   */
  async upsert(
    addr: string,
    tokenId: string,
    next: TokenManifestEntry,
  ): Promise<TokenManifestEntry> {
    let lastResult: ManifestCasResult | null = null;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const current = await this.storage.readEntry(addr, tokenId);

      // Lamport bump per §7.1: observe both the current local Lamport
      // and the `next.lamport` input (treat each as a remote-observed
      // value). `Lamport.bumpFor` mutates the per-Sphere clock and
      // returns the next value.
      const observed: number[] = [];
      if (current?.lamport !== undefined) observed.push(current.lamport);
      if (next.lamport !== undefined) observed.push(next.lamport);
      const bumped = this.lamport.bumpFor(observed);

      const merged = mergeManifestEntry(current, { ...next, lamport: bumped });

      // CAS precondition: assert the current rootHash matches what we
      // observed at step 1. `null` if no current entry.
      const casPrev = current === undefined
        ? null
        : { contentHash: current.rootHash };

      // Non-CAS errors from storage propagate as-is. CAS-tagged errors
      // are caught inside ManifestCas.update and surfaced as a structured
      // outcome; only "real" failures (network, decryption, etc.) escape.
      const result = await this.cas.update(addr, tokenId, casPrev, merged);
      lastResult = result;
      if (result.ok) {
        return merged;
      }
      if (result.reason !== 'cas-mismatch' && result.reason !== 'concurrent-modification') {
        // Other reasons (`'not-found'`) shouldn't fire on `upsert` —
        // we always pass `null` precondition when current is undefined,
        // so the only way to land here is a programming error in the
        // CAS layer. Surface immediately rather than retry.
        break;
      }
      // Otherwise: loop and retry. No backoff — bounded by maxRetries.
    }

    throw new SphereError(
      `ManifestStore.upsert: CAS retries exhausted after ${this.maxRetries} attempts ` +
        `(addr=${addr}, tokenId=${tokenId}, lastReason=${lastResult?.ok === false ? lastResult.reason : 'unknown'})`,
      'MANIFEST_CAS_RETRY_EXHAUSTED',
    );
  }

  /**
   * Set the `audit_promoted_from` back-reference on an existing entry
   * (or create a new entry if none exists with the supplied delta).
   * Used by the audit-promotion path in {@link DispositionWriter}.
   *
   * **Set-OR semantics** (per §5.4): if the existing entry already
   * has `audit_promoted_from` set, the supplied `auditKeys` are
   * merged into the existing array (deduplicated, lex-sorted). Calling
   * this with the same `auditKeys` twice is therefore idempotent.
   */
  async addAuditPromotedFrom(
    addr: string,
    tokenId: string,
    auditKeys: ReadonlyArray<string>,
    baseDelta: TokenManifestEntry,
  ): Promise<TokenManifestEntry> {
    const next: TokenManifestEntry = {
      ...baseDelta,
      audit_promoted_from: unionStringArray(
        baseDelta.audit_promoted_from,
        auditKeys,
      ),
    };
    return this.upsert(addr, tokenId, next);
  }
}

// =============================================================================
// 4. Module-internal helpers
// =============================================================================

/**
 * Union two `string[] | undefined` arrays into a deduplicated, lex-sorted
 * array. Returns `undefined` if both inputs are absent / empty.
 */
function unionStringArray(
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
): readonly string[] | undefined {
  if ((a === undefined || a.length === 0) && (b === undefined || b.length === 0)) {
    return undefined;
  }
  const set = new Set<string>();
  if (a) for (const v of a) set.add(v);
  if (b) for (const v of b) set.add(v);
  return [...set].sort();
}

/**
 * Union two `ContentHash[] | undefined` arrays into a deduplicated,
 * lex-sorted array. Returns `undefined` if both inputs are absent / empty.
 */
function unionContentHashArray(
  a: ReadonlyArray<ContentHash> | undefined,
  b: ReadonlyArray<ContentHash> | undefined,
): readonly ContentHash[] | undefined {
  if ((a === undefined || a.length === 0) && (b === undefined || b.length === 0)) {
    return undefined;
  }
  const set = new Set<string>();
  if (a) for (const v of a) set.add(v);
  if (b) for (const v of b) set.add(v);
  return [...set].sort() as ContentHash[];
}

/**
 * Take `max(a, b)` of two `number | undefined` values. Returns
 * `undefined` if both are absent.
 */
function maxOpt(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

/**
 * Defense-in-depth chain-content winner pick when `prev.rootHash !==
 * next.rootHash`. Symmetric in `(prev, next)` so replicas converge to the
 * same persisted entry regardless of which side called the merge first.
 *
 * **Selection order** (each step is symmetric on its own):
 *   1. Both sides have `bundleCid` → lex-min `bundleCid` wins (§5.3
 *      [D-conflict] rule).
 *   2. Exactly one side has `bundleCid` → that side wins (more chain
 *      evidence; symmetric — outcome doesn't depend on arg order).
 *   3. Neither side has `bundleCid` → lex-min `rootHash` wins (last-resort
 *      tie-break; still symmetric across replicas).
 *
 * The canonical path runs `conflict-merger` (T.3.D) upstream and stamps the
 * winner as `next`; this fallback is defense-in-depth for callers that
 * bypass the conflict-merger.
 */
function pickChainWinnerSymmetric(
  prev: TokenManifestEntry,
  next: TokenManifestEntry,
  compareCidsBinary: (a: string, b: string) => -1 | 0 | 1,
): TokenManifestEntry {
  // 1) Both sides have bundleCid → lex-min wins.
  if (prev.bundleCid !== undefined && next.bundleCid !== undefined) {
    const cmp = safeCompareSymmetric(
      prev.bundleCid,
      next.bundleCid,
      compareCidsBinary,
    );
    return cmp <= 0 ? prev : next;
  }
  // 2) Exactly one side has bundleCid → that side wins (symmetric).
  if (prev.bundleCid !== undefined) return prev;
  if (next.bundleCid !== undefined) return next;
  // 3) Neither has bundleCid → tie-break on rootHash itself.
  const cmp = safeCompareSymmetric(prev.rootHash, next.rootHash, compareCidsBinary);
  return cmp <= 0 ? prev : next;
}

/**
 * Invoke `compareCidsBinary` with a fallback to plain string comparison if
 * parsing fails (e.g. legacy hex rootHash, malformed CID, test stub passing
 * non-CID strings). Plain string compare is still symmetric and
 * deterministic across replicas — what matters is that both replicas reach
 * the same answer for the same inputs, regardless of arg order.
 */
function safeCompareSymmetric(
  a: string,
  b: string,
  compareCidsBinary: (x: string, y: string) => -1 | 0 | 1,
): number {
  try {
    return compareCidsBinary(a, b);
  } catch {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
}

/**
 * Strip `undefined` properties from an object literal. Pure / shallow.
 * Used to keep the on-disk manifest entry minimal — `audit_promoted_from
 * = undefined` would serialize as a key in some encoders.
 */
function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

// =============================================================================
// Re-exports for ergonomic consumption
// =============================================================================

export { ManifestCasConcurrentModificationError } from './manifest-cas.js';
