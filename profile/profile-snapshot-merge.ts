/**
 * Shared CRDT merge primitive for full-profile snapshot JOIN
 * (Item #15 Phase B).
 *
 * Each per-entry-key writer that lives in OrbitDB (OutboxWriter,
 * SentLedgerWriter, DispositionWriter, FinalizationQueueStorageAdapter,
 * RecipientContextStorageAdapter, bundle-ref index) gains the
 * {@link ProfileSyncWriter} surface — `snapshot()` returns its
 * per-writer slice of the encrypted KV namespace, and
 * `joinSnapshot(remote)` applies the snapshot table from
 * `docs/uxf/OUTBOX-SEND-FOLLOWUPS.md` Item #15 Phase B to converge
 * local state against the remote.
 *
 * The merge table (`mergeSlots`):
 *
 * | Local      | Remote     | Result                                            |
 * |------------|------------|---------------------------------------------------|
 * | absent     | live       | write remote                                      |
 * | absent     | tombstone  | write remote (tombstone lands locally)            |
 * | live       | live       | write the one with higher Lamport                 |
 * | live       | tombstone  | tombstone wins iff `tomb.lamport >= live.lamport` |
 * | tombstone  | live       | live wins ONLY iff `live.lamport > tomb.lamport`  |
 * | tombstone  | tombstone  | keep the one with higher Lamport                  |
 *
 * The (live, tombstone) row is the **existing refuse-write guard from
 * Issue #166 P1 #2**, applied at JOIN time. The (tombstone, live) row
 * is its dual: a live entry with strictly-higher Lamport may resurrect
 * a tombstone, but ties favour the tombstone — keeping the existing
 * write-time invariant "tombstone is sticky at the same Lamport"
 * symmetric across replicas.
 *
 * **Tie-break behaviour (equal Lamports).** At Lamport equality the
 * tables resolve to:
 *   - live + live   → no-op (local wins)
 *   - tomb + tomb   → no-op (local wins)
 *   - live + tomb   → tombstone wins (refuse-write guard symmetry)
 *   - tomb + live   → tombstone wins (refuse-write guard symmetry)
 *
 * The two no-op cases mean a true content tie at the same Lamport will
 * NOT converge across replicas via this primitive alone. In practice
 * the Lamport bump rule (§7.1) guarantees fresh writes produce
 * monotonically-distinct Lamports per replica, so equal-Lamport
 * collisions only arise when two replicas independently raced from
 * cold-start without observing each other — the very next mutation on
 * either side resolves it.
 *
 * **What this layer is NOT.** This is a per-entry "shape" merge —
 * it picks ONE side's encrypted bytes verbatim. Per-field CRDT logic
 * (e.g. the OUTBOX merger's status partition lattice, the
 * `submitRetryCount` G-counter, request-id set union, etc.) does NOT
 * run cross-replica via this primitive. Field-level merging continues
 * to happen at WRITE time inside each writer's own code path (the
 * refuse-write guard, the sticky `everFinalizing` flag, etc.).
 *
 * Phase B is the first crack at JOIN-time merging — if soak shows
 * field-level divergence problems in the high-volume OUTBOX path
 * (e.g. retry counters resetting after JOIN), a follow-up wave can
 * layer per-field merges on top of `runJoinSnapshot` by replacing
 * `writeRemote` with a "merge then write" callback that runs the
 * writer's own merger before persisting.
 *
 * **Security / forgery defence.** Encrypted bytes are only forgeable
 * by holders of the wallet's master key (i.e. the same mnemonic), so
 * the JOIN layer trusts the bytes' authenticity. We still bounds-check
 * the Lamport value inside the decrypted payload via
 * {@link MAX_SAFE_LAMPORT} so a corrupted or malicious local-write
 * cannot stamp a runaway value that would force every replica past
 * the JS safe-integer range on subsequent bumps. This is the JOIN-time
 * counterpart of {@link Lamport.bumpFor}'s W39 bounds defence.
 *
 * @module profile/profile-snapshot-merge
 * @see docs/uxf/OUTBOX-SEND-FOLLOWUPS.md — Item #15 Phase B
 * @see profile/lamport.ts — §7.1 Lamport invariants, W39 bounds defence
 */

// =============================================================================
// 1. Constants
// =============================================================================

/**
 * Defensive cap on Lamport values observed at JOIN time. Any decrypted
 * entry whose `lamport` exceeds this bound is treated as malformed and
 * silently skipped — the local state retains its existing slot.
 *
 * **Why 2^48** (not `Number.MAX_SAFE_INTEGER = 2^53 − 1`):
 *   - Comfortable headroom below 2^53; subsequent bumps from this value
 *     do not approach the safe-integer boundary even after millions of
 *     additional writes.
 *   - 2^48 ≈ 2.8 × 10^14 — at a sustained 1M writes/sec it would take
 *     ~9 years to reach. Real wallets see fewer than 1k writes per
 *     entry over their lifetime; the bound is firmly in "should never
 *     happen" territory.
 *   - A single corrupted entry stamped at the bound is harmless: the
 *     local clock observes it via {@link Lamport.rehydrate} on cold
 *     restart, but the W39 bounds defence inside `bumpFor` still gates
 *     future remote OBSERVATIONS against `2 × local`, so a runaway
 *     local lamport doesn't propagate further than this peer.
 */
export const MAX_SAFE_LAMPORT = 2 ** 48;

// =============================================================================
// 2. Public types
// =============================================================================

/**
 * One per-entry snapshot record. `key` is the full OrbitDB key (typically
 * `${addressId}.{writerType}.{entryId}`). `encryptedValue` is the raw
 * bytes as stored — either AES-256-GCM ciphertext (when the writer was
 * constructed with an encryption key) or plaintext JSON (when not).
 *
 * The JOIN layer writes these bytes VERBATIM into the local OrbitDB when
 * the merge table says "remote wins" — it does not re-encrypt. This is
 * safe because:
 *   - sender + receiver share the same mnemonic, hence the same
 *     AES-256-GCM key, hence the receiver can decrypt the sender's
 *     ciphertext;
 *   - re-encrypting would change the ciphertext (fresh IV) and force
 *     subsequent snapshots to diverge byte-wise from this peer's
 *     persisted state — losing the determinism the lean-snapshot
 *     builder relies on.
 */
export interface SnapshotEntry {
  readonly key: string;
  readonly encryptedValue: Uint8Array;
}

/**
 * The discriminated slot classification consumed by {@link mergeSlots}.
 *
 * Each per-writer classifier (`classifyLocal`, `classifyRemote`)
 * decrypts the bytes, JSON-parses, sniffs the tombstone marker, and
 * extracts the `lamport` field. Schema-specific concerns (e.g. is the
 * payload a valid `UxfTransferOutboxEntry`?) are out of scope for the
 * merge primitive — only the slot shape + Lamport matter for
 * convergence.
 */
export type ClassifiedSlot =
  | { readonly kind: 'absent' }
  | { readonly kind: 'live'; readonly lamport: number }
  | { readonly kind: 'tombstone'; readonly lamport: number };

/**
 * The outcome of {@link mergeSlots} — either keep local untouched or
 * write the remote bytes verbatim. `remoteKind` on the `write-remote`
 * branch lets the caller bucket the JOIN counters by what landed.
 */
export type MergeAction =
  | { readonly kind: 'noop'; readonly reason: NoopReason }
  | { readonly kind: 'write-remote'; readonly remoteKind: 'live' | 'tombstone' };

/**
 * Diagnostic reason for a no-op decision. Surfaced via {@link JoinResult}
 * for operator triage when JOIN convergence looks unexpected.
 */
export type NoopReason =
  | 'local-wins-lamport'  // local lamport ≥ remote and the table prefers local
  | 'local-equals-remote'  // exact byte equality — defensive optimisation
  | 'remote-absent';       // sentinel; not normally reachable via snapshot()

/**
 * Per-JOIN counters. Surfaced to the caller for logging + tests.
 */
export interface JoinResult {
  /** Number of remote entries inspected (including malformed). */
  readonly entriesEvaluated: number;
  /** Number of remote live entries that landed locally. */
  readonly liveLanded: number;
  /** Number of remote tombstones that landed locally. */
  readonly tombstonesLanded: number;
  /** Number of remote entries where local won (no-op). */
  readonly localWon: number;
  /**
   * Number of remote entries the JOIN refused to apply — either:
   *   - `classifyRemote` returned `null` (decrypt/parse failed,
   *     out-of-bounds Lamport, unknown shape);
   *   - `writeRemote` threw (storage error during apply).
   *
   * These leave the local slot untouched. The next JOIN pass retries
   * naturally if the remote re-publishes a well-formed entry.
   */
  readonly remoteRejectedMalformed: number;
}

/**
 * Per-writer surface for full-profile-snapshot sync (Item #15).
 *
 * `snapshot()` returns every entry under the writer's prefix as raw
 * encrypted bytes — the lean-snapshot builder concatenates per-writer
 * snapshots into the published CAR.
 *
 * `joinSnapshot(remote)` applies the snapshot table against the writer's
 * local state. Implementations typically delegate to
 * {@link runJoinSnapshot} with a per-writer classifier and writer.
 */
export interface ProfileSyncWriter {
  snapshot(): Promise<ReadonlyArray<SnapshotEntry>>;
  joinSnapshot(remote: ReadonlyArray<SnapshotEntry>): Promise<JoinResult>;
}

/**
 * Dependency block consumed by {@link runJoinSnapshot}. Each per-writer
 * `joinSnapshot()` instantiates one of these with bindings to its own
 * decrypt / classify / db.put surfaces.
 */
export interface JoinDeps {
  /**
   * Read + classify the local slot at the given key. MUST return
   * `'absent'` for missing keys and for any unrecoverable
   * decrypt/parse failure — treating decode failures as "absent"
   * maximises convergence (the remote, if well-formed, lands).
   *
   * `'live'` / `'tombstone'` carry the Lamport extracted from the
   * decoded payload. Classifiers that detect a forged Lamport beyond
   * {@link MAX_SAFE_LAMPORT} should treat the slot as absent so the
   * runaway value cannot propagate further.
   */
  readonly classifyLocal: (key: string) => Promise<ClassifiedSlot>;
  /**
   * Decrypt + classify the remote entry. MUST return `null` when the
   * payload is malformed or carries an out-of-bounds Lamport — the
   * runner reports such entries as `remoteRejectedMalformed` and
   * leaves the local slot untouched.
   *
   * Valid remote entries are only ever `'live'` or `'tombstone'` —
   * an "absent" remote does not appear in the snapshot.
   */
  readonly classifyRemote: (entry: SnapshotEntry) => Promise<ClassifiedSlot | null>;
  /**
   * Persist the remote's encrypted bytes verbatim under the given
   * key. Implementations typically wrap `db.put(key, encryptedValue)`.
   *
   * Throwing here surfaces as `remoteRejectedMalformed` in the result —
   * the JOIN loop continues with the next entry rather than aborting.
   */
  readonly writeRemote: (key: string, encryptedValue: Uint8Array) => Promise<void>;
}

// =============================================================================
// 3. Pure merge primitive
// =============================================================================

/**
 * Apply the Item #15 Phase B merge table to a (local, remote) slot
 * pair. Pure — no I/O, no mutation. The caller dispatches based on
 * the returned {@link MergeAction}.
 */
export function mergeSlots(
  local: ClassifiedSlot,
  remote: ClassifiedSlot,
): MergeAction {
  // Remote absent → no-op. Defensive — snapshot() returns only existing
  // entries, so this branch is mostly reachable via test fixtures that
  // construct synthetic ClassifiedSlot inputs.
  if (remote.kind === 'absent') {
    return { kind: 'noop', reason: 'remote-absent' };
  }

  // Local absent → remote always wins (live or tombstone).
  if (local.kind === 'absent') {
    return { kind: 'write-remote', remoteKind: remote.kind };
  }

  // live + live → higher Lamport wins. Equal Lamports → local wins (no-op).
  if (local.kind === 'live' && remote.kind === 'live') {
    if (remote.lamport > local.lamport) {
      return { kind: 'write-remote', remoteKind: 'live' };
    }
    return { kind: 'noop', reason: 'local-wins-lamport' };
  }

  // live + tombstone → tombstone wins if tombstone.lamport >= live.lamport.
  // Else local (live) wins. This is the existing refuse-write guard from
  // Issue #166 P1 #2, applied at JOIN time. The `>=` makes tombstones
  // sticky at Lamport ties.
  if (local.kind === 'live' && remote.kind === 'tombstone') {
    if (remote.lamport >= local.lamport) {
      return { kind: 'write-remote', remoteKind: 'tombstone' };
    }
    return { kind: 'noop', reason: 'local-wins-lamport' };
  }

  // tombstone + live → live wins ONLY if live.lamport > tombstone.lamport.
  // Else tombstone preserved. Symmetric to the (live, tombstone) row —
  // tombstones are sticky at ties.
  if (local.kind === 'tombstone' && remote.kind === 'live') {
    if (remote.lamport > local.lamport) {
      return { kind: 'write-remote', remoteKind: 'live' };
    }
    return { kind: 'noop', reason: 'local-wins-lamport' };
  }

  // tombstone + tombstone → higher Lamport wins. Equal Lamports →
  // local wins (no-op).
  if (local.kind === 'tombstone' && remote.kind === 'tombstone') {
    if (remote.lamport > local.lamport) {
      return { kind: 'write-remote', remoteKind: 'tombstone' };
    }
    return { kind: 'noop', reason: 'local-wins-lamport' };
  }

  // Exhaustive — the type system says every combination above is
  // covered, but TypeScript's discriminated-union narrowing doesn't
  // prove it here. Defensive fall-through preserves local on any
  // unreachable shape.
  return { kind: 'noop', reason: 'local-wins-lamport' };
}

// =============================================================================
// 4. JOIN runner
// =============================================================================

/**
 * Drive the JOIN loop: for every remote entry, classify both sides,
 * apply {@link mergeSlots}, persist the remote bytes when remote wins.
 *
 * **Loop invariants** (Phase B):
 *   - Idempotent: re-running the JOIN with the same remote on the same
 *     local state is a no-op (the prior pass already converged the
 *     pair).
 *   - Order-independent (single-process correctness): the loop processes
 *     remote entries sequentially, but each per-entry merge is
 *     independent of the others — running them in any order yields the
 *     same final state.
 *   - Crash-safe per-entry: each `writeRemote` is one atomic OrbitDB
 *     put. A crash mid-loop leaves a partial JOIN; the next sync pass
 *     converges the missing entries.
 *
 * **Defensive error handling**:
 *   - `classifyRemote` throw / return `null` → entry counted as
 *     `remoteRejectedMalformed`; loop continues.
 *   - `classifyLocal` throw → treated as `'absent'` so the remote (if
 *     well-formed) lands. This biases convergence; the alternative —
 *     skipping — would leave the local in an inconsistent state
 *     across replicas if the local decode failure is persistent.
 *   - `writeRemote` throw → counted as `remoteRejectedMalformed`;
 *     loop continues. The local slot is untouched; the next JOIN pass
 *     retries.
 */
export async function runJoinSnapshot(
  remote: ReadonlyArray<SnapshotEntry>,
  deps: JoinDeps,
): Promise<JoinResult> {
  let entriesEvaluated = 0;
  let liveLanded = 0;
  let tombstonesLanded = 0;
  let localWon = 0;
  let remoteRejectedMalformed = 0;

  for (const entry of remote) {
    entriesEvaluated += 1;

    let remoteSlot: ClassifiedSlot | null;
    try {
      remoteSlot = await deps.classifyRemote(entry);
    } catch {
      remoteRejectedMalformed += 1;
      continue;
    }
    if (remoteSlot === null || remoteSlot.kind === 'absent') {
      remoteRejectedMalformed += 1;
      continue;
    }

    let localSlot: ClassifiedSlot;
    try {
      localSlot = await deps.classifyLocal(entry.key);
    } catch {
      // Treat local decode failure as absent — biases convergence
      // toward landing the remote.
      localSlot = { kind: 'absent' };
    }

    const action = mergeSlots(localSlot, remoteSlot);
    if (action.kind === 'noop') {
      localWon += 1;
      continue;
    }

    try {
      await deps.writeRemote(entry.key, entry.encryptedValue);
      if (action.remoteKind === 'live') {
        liveLanded += 1;
      } else {
        tombstonesLanded += 1;
      }
    } catch {
      remoteRejectedMalformed += 1;
    }
  }

  return {
    entriesEvaluated,
    liveLanded,
    tombstonesLanded,
    localWon,
    remoteRejectedMalformed,
  };
}

// =============================================================================
// 5. Lamport bounds helper for classifiers
// =============================================================================

/**
 * Extract and validate a Lamport value from a decoded payload field.
 * Returns the number on success, or `null` if the field is missing,
 * non-integer, negative, NaN, infinite, or above {@link MAX_SAFE_LAMPORT}.
 *
 * Classifiers should use this to reject corrupted/malicious Lamports
 * before constructing a {@link ClassifiedSlot}. Returning `null` from
 * the classifier surfaces as `remoteRejectedMalformed` in the JOIN
 * result, leaving the local slot untouched.
 */
export function validateLamport(raw: unknown): number | null {
  if (typeof raw !== 'number') return null;
  if (!Number.isFinite(raw)) return null;
  if (!Number.isInteger(raw)) return null;
  if (raw < 0) return null;
  if (raw > MAX_SAFE_LAMPORT) return null;
  return raw;
}
