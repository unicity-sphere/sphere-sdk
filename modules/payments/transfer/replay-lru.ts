/**
 * Replay LRU — UXF Inter-Wallet Transfer recipient (T.3.A).
 *
 * Bounded set of recently-processed `bundleCid` values, partitioned into
 * **per-sender sub-buckets** for cross-sender eviction defense (Note N5).
 *
 * Why this exists (§5.1):
 *   Re-processing the same `bundleCid` is **idempotent** by construction —
 *   tokens are identified by their immutable `tokenId`, and the local pool
 *   only ever holds one canonical copy per id (updated monotonically with
 *   the longest valid chain of finalized transactions). Re-processing
 *   wastes compute but cannot diverge from the first processing. This LRU
 *   is therefore an **optimization**, not a correctness gate — eviction is
 *   harmless.
 *
 * Why per-sender sub-buckets (Note N5):
 *   A FLAT global LRU (one shared `Set<bundleCid>` capped at 256) is
 *   correct in the honest case but **vulnerable to cross-sender eviction**:
 *   a hostile sender with a high-rate publish pipeline can flood the LRU
 *   with junk `bundleCid` values, evicting honest senders' entries before
 *   the wallet has finished its short-circuit window. The honest entries
 *   then re-trigger the full §5.2 verification pipeline (CAR-parse, hash
 *   recomputation, `pkg.verify()`) on legitimate replays — wasted compute
 *   the LRU was meant to prevent.
 *
 *   Defense: PARTITION the LRU by sender pubkey. Each sender gets a
 *   private sub-bucket; a hostile sender can ONLY evict entries from
 *   their OWN bucket. Honest senders' entries are protected by isolation,
 *   not by sheer LRU size.
 *
 * Eviction policy (this implementation):
 *   - **Per-sender cap** (`maxPerSender`, default 64): each sender's
 *     sub-bucket is a private LRU of bundleCids. When a new entry is
 *     added beyond the cap, the **oldest entry within that sender's
 *     bucket** is evicted. Critically: NEVER evicts another sender's
 *     entry.
 *   - **Global sender-bucket cap** (`maxSenders`, default 32): caps the
 *     number of distinct sender pubkeys we track simultaneously to bound
 *     memory. When we exceed this and a NEW sender appears, the
 *     **least-recently-active sender's entire sub-bucket** is dropped.
 *     This still satisfies N5: no honest sender's entries are evicted by
 *     a hostile sender's activity unless the hostile sender is faster
 *     than ALL the honest senders combined — and even then, the eviction
 *     is whole-bucket, not entry-by-entry, so a single hostile sender
 *     cannot starve any specific honest sender's bucket while that
 *     sender is also producing traffic.
 *
 *   The two-tier policy (per-sender LRU within bucket, LRU across
 *   buckets at the sender-pubkey granularity) ensures the worst-case
 *   memory is bounded by `maxSenders * maxPerSender` entries.
 *
 * Memory bound (defaults):
 *   `maxSenders * maxPerSender = 32 * 64 = 2048` entries — safely above
 *   the spec's `REPLAY_LRU_SIZE` of 256 (the protocol's _flat_ target)
 *   without being unboundedly expensive. Each entry is a CID string
 *   (typically ~60 bytes), so worst case is ~120 KiB resident.
 *
 * Thread safety:
 *   This implementation is single-threaded (Node.js / browser microtask
 *   model). Concurrent add/has from N parallel ingest workers (§5.0)
 *   relies on the JavaScript event loop's run-to-completion guarantee.
 *   No locks needed — `add` and `has` complete synchronously between
 *   awaits.
 *
 * Spec references:
 *   - §5.1   Replay handling (bounded LRU is purely an optimization).
 *   - §5.6   Idempotency invariants (replay must never regress
 *            disposition; LRU short-circuit is a no-op).
 *
 * @packageDocumentation
 */

import { REPLAY_LRU_SIZE } from './limits.js';

// =============================================================================
// 1. Tunable constants — defaults
// =============================================================================

/**
 * Default maximum bundleCid entries per sender sub-bucket. Honest wallets
 * exchange far fewer than 64 distinct bundles in any reasonable wall-clock
 * window (the LRU is sized for the freshest in-flight set, not all-time
 * history).
 */
export const MAX_PER_SENDER = 64;

/**
 * Default maximum number of distinct sender pubkeys we track
 * simultaneously. When exceeded, the oldest sender's entire sub-bucket is
 * dropped to make room (the dropped sender's entries simply cease to
 * short-circuit on replay, which is correct per §5.6 — replay re-runs
 * §5.2 idempotently).
 */
export const MAX_SENDERS = 32;

// =============================================================================
// 2. Public API — ReplayLRU
// =============================================================================

/**
 * Per-sender-bucketed replay LRU. See module-level docs for the rationale
 * behind the partitioning (Note N5).
 *
 * Construction parameters are exposed for tests; production callers should
 * accept the defaults.
 */
export class ReplayLRU {
  /**
   * Map from sender pubkey (transport pubkey, 64-hex string) to that
   * sender's private sub-bucket. The Map's insertion order doubles as
   * sender-level recency for the global eviction tier — when a sender's
   * bucket is touched (via `add`), we delete-and-reinsert the key so it
   * moves to the back of the iteration order.
   *
   * Each bucket is itself a `Set<string>` whose insertion order doubles
   * as bundleCid-level recency within that sender. The same delete-then-
   * insert dance refreshes recency on `add` of an existing entry.
   */
  private readonly buckets = new Map<string, Set<string>>();

  /** Per-sender cap (default {@link MAX_PER_SENDER}). */
  private readonly maxPerSender: number;
  /** Global sender-bucket cap (default {@link MAX_SENDERS}). */
  private readonly maxSenders: number;

  /**
   * @param opts.maxPerSender Override per-sender cap (tests).
   * @param opts.maxSenders   Override global cap (tests).
   *
   * @throws {RangeError} If either cap is `<= 0` or non-finite.
   */
  constructor(opts?: { readonly maxPerSender?: number; readonly maxSenders?: number }) {
    this.maxPerSender = opts?.maxPerSender ?? MAX_PER_SENDER;
    this.maxSenders = opts?.maxSenders ?? MAX_SENDERS;
    if (this.maxPerSender < 1 || !Number.isFinite(this.maxPerSender)) {
      throw new RangeError(`ReplayLRU: maxPerSender must be >= 1 (got ${this.maxPerSender})`);
    }
    if (this.maxSenders < 1 || !Number.isFinite(this.maxSenders)) {
      throw new RangeError(`ReplayLRU: maxSenders must be >= 1 (got ${this.maxSenders})`);
    }
  }

  /**
   * Returns true iff this `(senderPubkey, bundleCid)` pair has been seen
   * recently (i.e., is still in the sender's sub-bucket). DOES NOT touch
   * or refresh the entry — read-only side-effect-free check.
   *
   * The (sender, cid) pairing is intentional: the same `bundleCid` from a
   * DIFFERENT sender does NOT short-circuit the second sender's bundle.
   * Two senders publishing the same CID is rare (a republish), but
   * processing both is the safe default — the second processing is a
   * no-op via §5.3 [D] anyway, so there's no correctness loss for the
   * extra paranoia.
   */
  has(senderPubkey: string, bundleCid: string): boolean {
    const bucket = this.buckets.get(senderPubkey);
    if (!bucket) return false;
    return bucket.has(bundleCid);
  }

  /**
   * Record that `(senderPubkey, bundleCid)` has been processed. Triggers
   * two layers of LRU eviction as needed:
   *
   *   1. Within the sender's bucket, evict the oldest bundleCid when
   *      the bucket exceeds {@link maxPerSender}. Bounded — never
   *      evicts another sender's entry.
   *   2. Across senders, evict the least-recently-active sender's
   *      entire bucket when the number of tracked senders exceeds
   *      {@link maxSenders}. The "least-recently-active" sender is the
   *      first-inserted key in the buckets Map.
   *
   * Recency tracking uses delete-then-insert on the Map and Set — both
   * collections iterate in insertion order, so re-inserting a key moves
   * it to the back (the "most recent" position).
   */
  add(senderPubkey: string, bundleCid: string): void {
    let bucket = this.buckets.get(senderPubkey);
    if (bucket) {
      // Sender already tracked — refresh sender-level recency by
      // delete-and-reinsert (Map iteration order is insertion order).
      this.buckets.delete(senderPubkey);
      this.buckets.set(senderPubkey, bucket);
    } else {
      // New sender. Allocate a fresh bucket, then enforce the global
      // sender-count cap.
      bucket = new Set<string>();
      this.buckets.set(senderPubkey, bucket);
      while (this.buckets.size > this.maxSenders) {
        const oldestSender = this.buckets.keys().next().value as string | undefined;
        if (oldestSender === undefined || oldestSender === senderPubkey) {
          // Defensive: shouldn't happen — we just inserted senderPubkey,
          // so it's at the back of iteration order, never at the front
          // when size > 1. Bail to avoid evicting the brand-new entry
          // and looping forever.
          break;
        }
        const evicted = this.buckets.get(oldestSender);
        if (evicted) evicted.clear();
        this.buckets.delete(oldestSender);
      }
    }

    // Refresh bundleCid-level recency within this sender's bucket.
    bucket.delete(bundleCid);
    bucket.add(bundleCid);

    // Enforce per-sender cap. Evict the OLDEST entry from THIS sender's
    // bucket — never reaching into another sender's bucket (Note N5).
    while (bucket.size > this.maxPerSender) {
      const oldest = bucket.values().next().value as string | undefined;
      if (oldest === undefined) break; // defensive
      bucket.delete(oldest);
    }
  }

  /**
   * Empty the entire LRU. Useful for tests, key rotation, or on
   * `Sphere.clear()` to drop any forensically-sensitive sender pubkeys
   * from in-process memory.
   */
  clear(): void {
    for (const bucket of this.buckets.values()) {
      bucket.clear();
    }
    this.buckets.clear();
  }

  // ---------- Test-visible accessors ----------

  /** Total bundleCid entries across all sender buckets. */
  get totalEntries(): number {
    let n = 0;
    for (const bucket of this.buckets.values()) {
      n += bucket.size;
    }
    return n;
  }

  /** Number of senders currently tracked. */
  get senderCount(): number {
    return this.buckets.size;
  }

  /**
   * Number of bundleCid entries in `senderPubkey`'s sub-bucket, or `0`
   * if no bucket exists. For test assertions on per-sender state.
   */
  bucketSize(senderPubkey: string): number {
    return this.buckets.get(senderPubkey)?.size ?? 0;
  }
}

// =============================================================================
// 3. Re-export the spec-pinned global cap (callers may use this for
//    metric reporting, not for sizing — sizing is per-sender)
// =============================================================================

export { REPLAY_LRU_SIZE };
