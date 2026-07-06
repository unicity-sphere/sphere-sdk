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
 *   **Note N5 — within-tier protection only.** Per-entry eviction inside
 *   a sender's bucket is bounded by `maxPerSender`. The Note N5 isolation
 *   guarantee covers PER-ENTRY eviction inside a single bucket; it does
 *   NOT cover BUCKET-LEVEL eviction (the sender-tier eviction that drops
 *   an entire least-recently-active sender bucket when too many senders
 *   are tracked). Bucket-level eviction is the attack surface addressed by
 *   the trusted/untrusted split below.
 *
 * Eviction policy (this implementation):
 *   - **Per-sender cap** (`maxPerSender`, default 64): each sender's
 *     sub-bucket is a private LRU of bundleCids. When a new entry is
 *     added beyond the cap, the **oldest entry within that sender's
 *     bucket** is evicted. Critically: NEVER evicts another sender's
 *     entry.
 *   - **Trusted vs untrusted sender pools (Option B post-steelman):**
 *     senders are partitioned into TWO independent sender-bucket pools
 *     with separate caps:
 *
 *       - `untrustedSenders` (cap {@link MAX_UNTRUSTED_SENDERS} = 64) —
 *         absorbs every fresh sender we have not yet observed deliver a
 *         verified bundle. A sybil flood of throwaway pubkeys churns
 *         within this pool ONLY; the trusted pool is unaffected.
 *       - `trustedSenders` (cap {@link MAX_TRUSTED_SENDERS} = 256) —
 *         senders that have delivered at least one successfully-verified
 *         bundle (the bundle-acquirer calls
 *         {@link ReplayLRU#markSenderTrusted} after `pkg.verify()`
 *         succeeds). Once graduated, a sender's bucket lives in the
 *         protected pool and is immune to sybil-driven sender churn.
 *
 *     Cross-pool isolation: bucket-level eviction in `untrustedSenders`
 *     CANNOT evict any entry in `trustedSenders`. A hostile actor
 *     publishing thousands of throwaway pubkeys-per-second can fill and
 *     churn `untrustedSenders` indefinitely without affecting any
 *     trusted sender. The trusted pool's own eviction tier still uses
 *     LRU-within-bucket and LRU-across-buckets (so a trusted-pool
 *     overflow drops the LEAST-RECENTLY-ACTIVE trusted sender), but an
 *     attacker cannot cheaply enter the trusted pool — entry requires
 *     a verified bundle, which itself requires the attacker to ship a
 *     valid CAR + valid `pkg.verify()` + valid signature, work the
 *     wallet already had to perform regardless.
 *
 *     **Why we chose Option B post-steelman:** the prior Option A (a
 *     single 256-cap pool) raised the attacker's cost ~8× but did not
 *     CLOSE the attack: a sustained 256+ sybil pubkey/sec churn can
 *     still evict an honest sender's bucket entirely the moment their
 *     bucket becomes the oldest. Note N5 protects per-ENTRY eviction
 *     inside a bucket; nothing in the prior policy protected
 *     bucket-LEVEL eviction. Option B restores the Note N5 invariant
 *     for trusted senders: their buckets cannot be evicted by sybil
 *     churn, AT ALL. Memory cost is unchanged at worst case
 *     `(MAX_UNTRUSTED_SENDERS + MAX_TRUSTED_SENDERS) * MAX_PER_SENDER =
 *     320 * 64 = 20480` entries × ~60-byte CIDs ≈ 1.2 MiB resident.
 *     Acceptable for a wallet that already holds tens of MiB for token
 *     state.
 *
 *   The two-tier policy (per-sender LRU within bucket, LRU across
 *   buckets at the sender-pubkey granularity, with each pool managed
 *   independently) ensures the worst-case memory is bounded by
 *   `(maxUntrustedSenders + maxTrustedSenders) * maxPerSender` entries.
 *
 * Memory bound (defaults):
 *   `(MAX_UNTRUSTED_SENDERS + MAX_TRUSTED_SENDERS) * MAX_PER_SENDER =
 *   (64 + 256) * 64 = 20480` entries — well above the spec's
 *   `REPLAY_LRU_SIZE` of 256 (the protocol's _flat_ target). Each entry
 *   is a CID string (typically ~60 bytes), so worst case is ~1.2 MiB
 *   resident — comfortably bounded.
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
 * Default maximum number of distinct UNTRUSTED sender pubkeys we track
 * simultaneously. When exceeded, the oldest untrusted sender's entire
 * sub-bucket is dropped to make room. The dropped sender's entries
 * simply cease to short-circuit on replay (correct per §5.6 — replay
 * re-runs §5.2 idempotently).
 *
 * **Option B post-steelman.** This pool is the absorber for sybil
 * churn: every fresh sender we have not yet observed deliver a verified
 * bundle starts here. A hostile actor flooding ephemeral pubkeys
 * exhausts THIS pool (and ONLY this pool); trusted senders are
 * untouched. The cap is intentionally smaller than `MAX_TRUSTED_SENDERS`
 * because untrusted entries are short-lived by design — they exist
 * only to short-circuit duplicate verification attempts before
 * graduation, which legitimately happens within a single
 * verify-and-mark-trusted window for an honest first contact.
 */
export const MAX_UNTRUSTED_SENDERS = 64;

/**
 * Default maximum number of distinct TRUSTED sender pubkeys we track
 * simultaneously. Once a sender has had at least one
 * successfully-verified bundle (the acquirer calls
 * {@link ReplayLRU#markSenderTrusted} on success), their bucket lives
 * in this pool. The trusted pool is IMMUNE to bucket-level eviction
 * driven by untrusted churn: only trusted-pool overflow can evict a
 * trusted bucket, and trusted-pool overflow requires the attacker to
 * have already shipped >256 distinct verified bundles from distinct
 * Nostr signing keys, which is dramatically more expensive than the
 * sybil pubkey churn used to attack a single-pool design.
 *
 * Worst-case memory contribution: `MAX_TRUSTED_SENDERS * MAX_PER_SENDER
 * = 256 * 64 = 16384` entries × ~60-byte CIDs ≈ 960 KiB.
 */
export const MAX_TRUSTED_SENDERS = 256;

/**
 * Steelman fix: canonicalize sender pubkey before keying the LRU
 * buckets. Without this, casing variants ('AB...' vs 'ab...') of the
 * SAME hex string would route the same logical sender into separate
 * buckets, defeating the Note N5 isolation guarantee.
 *
 * We deliberately do NOT enforce a strict 64-hex format here — tests
 * and synthetic harnesses pass opaque short strings as sender ids.
 * Production wiring is responsible for passing the AUTHENTICATED Nostr
 * signing pubkey (the `pubkey` field of the Nostr event after signature
 * validation), NOT the unauthenticated `payload.sender.transportPubkey`
 * claim. Casing-normalization defends against UI-layer / decoder
 * variants that uppercase the hex; the Note N5 isolation guarantee
 * holds because the same authenticated bytes always lowercase to the
 * same key.
 */
function canonicalSenderPubkey(senderPubkey: string): string {
  if (typeof senderPubkey !== 'string') {
    throw new TypeError('ReplayLRU: senderPubkey must be a string');
  }
  if (senderPubkey.length === 0) {
    throw new TypeError('ReplayLRU: senderPubkey must be a non-empty string');
  }
  // Hex-style strings are case-folded to lowercase. Non-hex strings
  // (synthetic test ids like 'sender_a') pass through unchanged.
  if (/^[0-9a-fA-F]+$/.test(senderPubkey)) {
    return senderPubkey.toLowerCase();
  }
  return senderPubkey;
}

// =============================================================================
// 2. Public API — ReplayLRU
// =============================================================================

/**
 * Per-sender-bucketed replay LRU. See module-level docs for the rationale
 * behind the partitioning (Note N5) and the trusted/untrusted split.
 *
 * Construction parameters are exposed for tests; production callers should
 * accept the defaults.
 */
export class ReplayLRU {
  /**
   * Map from sender pubkey (transport pubkey, 64-hex string) to that
   * sender's private sub-bucket — UNTRUSTED pool. Senders we have not
   * yet observed deliver a verified bundle live here. A hostile sybil
   * flood churns within THIS map only.
   *
   * The Map's insertion order doubles as sender-level recency for the
   * pool's bucket-level eviction tier — when a sender's bucket is
   * touched (via `add`), we delete-and-reinsert the key so it moves to
   * the back of iteration order.
   *
   * Each bucket is itself a `Set<string>` whose insertion order doubles
   * as bundleCid-level recency within that sender. The same delete-then-
   * insert dance refreshes recency on `add` of an existing entry.
   */
  private readonly untrustedSenders = new Map<string, Set<string>>();

  /**
   * Map from sender pubkey to that sender's private sub-bucket —
   * TRUSTED pool. Senders are admitted via {@link markSenderTrusted}
   * AFTER `pkg.verify()` succeeds (called by the bundle-acquirer). This
   * pool is immune to sybil-driven bucket-level eviction: only trusted
   * pool overflow (> `maxTrustedSenders`) can evict a trusted bucket,
   * and that requires the attacker to have already shipped enough
   * verified bundles from distinct signing keys to fill the pool — a
   * dramatically higher cost than untrusted-pool sybil churn.
   */
  private readonly trustedSenders = new Map<string, Set<string>>();

  /** Per-sender cap (default {@link MAX_PER_SENDER}). */
  private readonly maxPerSender: number;
  /** Untrusted-pool cap (default {@link MAX_UNTRUSTED_SENDERS}). */
  private readonly maxUntrustedSenders: number;
  /** Trusted-pool cap (default {@link MAX_TRUSTED_SENDERS}). */
  private readonly maxTrustedSenders: number;

  /**
   * @param opts.maxPerSender         Override per-sender cap (tests).
   * @param opts.maxUntrustedSenders  Override untrusted-pool cap (tests).
   * @param opts.maxTrustedSenders    Override trusted-pool cap (tests).
   *
   * @throws {RangeError} If any cap is `<= 0` or non-finite.
   */
  constructor(opts?: {
    readonly maxPerSender?: number;
    readonly maxUntrustedSenders?: number;
    readonly maxTrustedSenders?: number;
  }) {
    this.maxPerSender = opts?.maxPerSender ?? MAX_PER_SENDER;
    this.maxUntrustedSenders = opts?.maxUntrustedSenders ?? MAX_UNTRUSTED_SENDERS;
    this.maxTrustedSenders = opts?.maxTrustedSenders ?? MAX_TRUSTED_SENDERS;
    if (this.maxPerSender < 1 || !Number.isFinite(this.maxPerSender)) {
      throw new RangeError(`ReplayLRU: maxPerSender must be >= 1 (got ${this.maxPerSender})`);
    }
    if (this.maxUntrustedSenders < 1 || !Number.isFinite(this.maxUntrustedSenders)) {
      throw new RangeError(
        `ReplayLRU: maxUntrustedSenders must be >= 1 (got ${this.maxUntrustedSenders})`,
      );
    }
    if (this.maxTrustedSenders < 1 || !Number.isFinite(this.maxTrustedSenders)) {
      throw new RangeError(
        `ReplayLRU: maxTrustedSenders must be >= 1 (got ${this.maxTrustedSenders})`,
      );
    }
  }

  /**
   * Returns true iff this `(senderPubkey, bundleCid)` pair has been seen
   * recently (i.e., is still in the sender's sub-bucket — either pool).
   * DOES NOT touch or refresh the entry — read-only side-effect-free
   * check.
   *
   * The (sender, cid) pairing is intentional: the same `bundleCid` from a
   * DIFFERENT sender does NOT short-circuit the second sender's bundle.
   * Two senders publishing the same CID is rare (a republish), but
   * processing both is the safe default — the second processing is a
   * no-op via §5.3 [D] anyway, so there's no correctness loss for the
   * extra paranoia.
   */
  has(senderPubkey: string, bundleCid: string): boolean {
    senderPubkey = canonicalSenderPubkey(senderPubkey);
    // Trusted pool first (more likely on hot path for honest peers).
    const trustedBucket = this.trustedSenders.get(senderPubkey);
    if (trustedBucket && trustedBucket.has(bundleCid)) return true;
    const untrustedBucket = this.untrustedSenders.get(senderPubkey);
    if (untrustedBucket && untrustedBucket.has(bundleCid)) return true;
    return false;
  }

  /**
   * Record that `(senderPubkey, bundleCid)` has been processed. Triggers
   * two layers of LRU eviction within the sender's CURRENT pool (trusted
   * if graduated, untrusted otherwise):
   *
   *   1. Within the sender's bucket, evict the oldest bundleCid when
   *      the bucket exceeds {@link maxPerSender}. Bounded — never
   *      evicts another sender's entry (Note N5).
   *   2. Across senders WITHIN THE SAME POOL, evict the
   *      least-recently-active sender's entire bucket when the number
   *      of tracked senders in that pool exceeds its cap. The
   *      "least-recently-active" sender is the first-inserted key in
   *      the pool's Map.
   *
   * Critically, Step 2 is pool-local: untrusted-pool overflow CANNOT
   * evict a trusted bucket (and vice-versa). New senders always start
   * in the untrusted pool.
   *
   * Recency tracking uses delete-then-insert on the Map and Set — both
   * collections iterate in insertion order, so re-inserting a key moves
   * it to the back (the "most recent" position).
   */
  add(senderPubkey: string, bundleCid: string): void {
    senderPubkey = canonicalSenderPubkey(senderPubkey);
    // Pick the sender's current pool. If they already exist in the
    // trusted pool, stay there. Otherwise, route to untrusted (new
    // sender or already-untrusted sender being refreshed).
    if (this.trustedSenders.has(senderPubkey)) {
      this.addToPool(this.trustedSenders, senderPubkey, bundleCid, this.maxTrustedSenders);
    } else {
      this.addToPool(this.untrustedSenders, senderPubkey, bundleCid, this.maxUntrustedSenders);
    }
  }

  /**
   * Graduate a sender into the trusted pool. Called by the
   * bundle-acquirer AFTER `pkg.verify()` succeeds for a bundle from
   * `senderPubkey`. Idempotent — calling on an already-trusted sender
   * is a no-op.
   *
   * Migration semantics: if the sender currently has an untrusted
   * bucket, that bucket is moved (NOT copied) into the trusted pool —
   * preserving every prior bundleCid the LRU has tracked for them.
   * The untrusted-pool slot is freed, allowing one more untrusted
   * sender to be tracked. The trusted-pool eviction tier then runs
   * (graduating into a full trusted pool can evict the
   * least-recently-active TRUSTED sender — never an untrusted sender).
   */
  markSenderTrusted(senderPubkey: string): void {
    senderPubkey = canonicalSenderPubkey(senderPubkey);
    if (this.trustedSenders.has(senderPubkey)) return; // already trusted
    const existingBucket = this.untrustedSenders.get(senderPubkey);
    const bucket = existingBucket ?? new Set<string>();
    if (existingBucket !== undefined) {
      this.untrustedSenders.delete(senderPubkey);
    }
    this.trustedSenders.set(senderPubkey, bucket);
    // Enforce trusted-pool cap. Note: we evict the OLDEST trusted
    // bucket — NEVER an untrusted bucket — so a graduation cannot
    // collateral-damage the untrusted pool.
    while (this.trustedSenders.size > this.maxTrustedSenders) {
      const oldestTrusted = this.trustedSenders.keys().next().value as string | undefined;
      if (oldestTrusted === undefined || oldestTrusted === senderPubkey) {
        // Defensive: the just-graduated sender is at the back of
        // iteration order, so it should never be the oldest when
        // size > 1.
        break;
      }
      const evicted = this.trustedSenders.get(oldestTrusted);
      if (evicted) evicted.clear();
      this.trustedSenders.delete(oldestTrusted);
    }
  }

  /**
   * Internal helper: add to a specific sender pool with its own
   * sender-level cap. Pure state mutation on the supplied `pool` Map;
   * does not touch the OTHER pool, preserving cross-pool isolation.
   */
  private addToPool(
    pool: Map<string, Set<string>>,
    senderPubkey: string,
    bundleCid: string,
    poolCap: number,
  ): void {
    let bucket = pool.get(senderPubkey);
    if (bucket) {
      // Sender already tracked in this pool — refresh sender-level
      // recency by delete-and-reinsert (Map iteration order is
      // insertion order).
      pool.delete(senderPubkey);
      pool.set(senderPubkey, bucket);
    } else {
      // New sender within this pool. Allocate a fresh bucket, then
      // enforce the pool's sender-count cap. POOL-LOCAL: this loop only
      // touches the supplied pool — it cannot evict from the other.
      bucket = new Set<string>();
      pool.set(senderPubkey, bucket);
      while (pool.size > poolCap) {
        const oldestSender = pool.keys().next().value as string | undefined;
        if (oldestSender === undefined || oldestSender === senderPubkey) {
          // Defensive: shouldn't happen — we just inserted senderPubkey,
          // so it's at the back of iteration order, never at the front
          // when size > 1. Bail to avoid evicting the brand-new entry
          // and looping forever.
          break;
        }
        const evicted = pool.get(oldestSender);
        if (evicted) evicted.clear();
        pool.delete(oldestSender);
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
   * Empty the entire LRU (both pools). Useful for tests, key rotation,
   * or on `Sphere.clear()` to drop any forensically-sensitive sender
   * pubkeys from in-process memory.
   */
  clear(): void {
    for (const bucket of this.untrustedSenders.values()) bucket.clear();
    this.untrustedSenders.clear();
    for (const bucket of this.trustedSenders.values()) bucket.clear();
    this.trustedSenders.clear();
  }

  // ---------- Test-visible accessors ----------

  /** Total bundleCid entries across both pools. */
  get totalEntries(): number {
    let n = 0;
    for (const bucket of this.untrustedSenders.values()) n += bucket.size;
    for (const bucket of this.trustedSenders.values()) n += bucket.size;
    return n;
  }

  /** Number of senders currently tracked across both pools. */
  get senderCount(): number {
    return this.untrustedSenders.size + this.trustedSenders.size;
  }

  /** Number of senders currently tracked in the untrusted pool. */
  get untrustedSenderCount(): number {
    return this.untrustedSenders.size;
  }

  /** Number of senders currently tracked in the trusted pool. */
  get trustedSenderCount(): number {
    return this.trustedSenders.size;
  }

  /**
   * Number of bundleCid entries in `senderPubkey`'s sub-bucket
   * (whichever pool they live in), or `0` if no bucket exists. For
   * test assertions on per-sender state.
   */
  bucketSize(senderPubkey: string): number {
    senderPubkey = canonicalSenderPubkey(senderPubkey);
    const t = this.trustedSenders.get(senderPubkey);
    if (t) return t.size;
    const u = this.untrustedSenders.get(senderPubkey);
    return u?.size ?? 0;
  }

  /**
   * Returns true iff `senderPubkey` is currently in the trusted pool.
   * Test-visible — production code should not branch on this; the
   * graduation policy is internal.
   */
  isTrusted(senderPubkey: string): boolean {
    senderPubkey = canonicalSenderPubkey(senderPubkey);
    return this.trustedSenders.has(senderPubkey);
  }
}

// =============================================================================
// 3. Re-export the spec-pinned global cap (callers may use this for
//    metric reporting, not for sizing — sizing is per-sender)
// =============================================================================

export { REPLAY_LRU_SIZE };
