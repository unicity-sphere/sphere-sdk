/**
 * Lamport logical clock — UXF Transfer Protocol §7.1 invariants.
 *
 * Used by the outbox CRDT (`UxfTransferOutboxEntry.lamport`) and the
 * manifest writers to obtain deterministic merge tie-breaks across
 * eventually-consistent OrbitDB replicas (e.g. desktop wallet vs.
 * browser wallet for the same identity).
 *
 * **Invariants (normative)** — see `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §7.1:
 * - On every local write to an entry, the writer reads the current
 *   `lamport` value AND the maximum `lamport` of any concurrently-observed
 *   remote replica's view of the same entry, then writes
 *   `lamport := max(local, observedRemotes) + 1`.
 * - On merge, `lamport := max(replicaA.lamport, replicaB.lamport)`.
 *
 * **Bounds defense (W39)**: a malicious or buggy replica could publish a
 * Lamport like `2^53` to force every honest replica past the JS
 * safe-integer range, breaking comparisons. We reject any observed remote
 * Lamport `> 2 × max(localKnownLamports, 1)` with `LAMPORT_BOUND_VIOLATION`.
 * The factor-of-two slack accommodates legitimate divergence (e.g. one
 * replica that has been offline writing locally for some time) while
 * ruling out runaway values. The `Math.max(_, 1)` floor lets boot accept
 * a reasonable first-remote Lamport (e.g. observing remote=1 from
 * local=0 is fine).
 *
 * **Per-instance scoping**: this class holds NO module-level state. Each
 * `Sphere` instance constructs its own `Lamport` so that destroy-recreate
 * cycles do not bleed Lamport state across wallet incarnations.
 */

import { SphereError } from '../../../core/errors';

/**
 * Per-replica Lamport clock. Single-threaded (JS event-loop) usage only;
 * the current value is mutated synchronously inside `bumpFor`.
 */
export class Lamport {
  /** The most-recently written Lamport value for the entry this clock
   *  tracks. Mutated by `bumpFor`; readable via `getCurrent`. */
  private current: number;

  /**
   * @param initial Starting Lamport value. Default `0`. Pass the value
   *   read from storage when re-hydrating a clock for an existing entry.
   */
  constructor(initial: number = 0) {
    if (!Number.isFinite(initial) || initial < 0 || !Number.isInteger(initial)) {
      throw new SphereError(
        `Lamport initial must be a non-negative finite integer; got ${String(initial)}`,
        'VALIDATION_ERROR',
      );
    }
    this.current = initial;
  }

  /**
   * CRDT merge rule: `max(a, b)`. Pure / static.
   */
  static merge(a: number, b: number): number {
    return Math.max(a, b);
  }

  /**
   * Compute the Lamport value for the next local write, given the set of
   * remote Lamport values currently observed for the same entry. Updates
   * this clock's internal `current` state and returns the new value.
   *
   * Behaviour:
   * - `result = max(this.current, max(observedRemotes, 0)) + 1`
   * - Empty `observedRemotes` is allowed (`getCurrent() + 1`).
   * - Throws `LAMPORT_BOUND_VIOLATION` if any observed value is
   *   `> 2 × max(this.current, 1)` — the W39 bounds defense.
   */
  bumpFor(observedRemotes: ReadonlyArray<number>): number {
    // Guard: untrusted input. Validate every entry before computing max.
    for (const v of observedRemotes) {
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
        throw new SphereError(
          `Lamport.bumpFor: observedRemotes must be non-negative finite integers; got ${String(v)}`,
          'VALIDATION_ERROR',
        );
      }
    }

    // Steelman fix: `Math.max(...arr)` throws RangeError on very large
    // arrays (typically >65k–125k entries depending on the engine). A
    // hostile replica feeding a million Lamports would DoS the merger
    // before the W39 bound check runs. reduce avoids the spread.
    let maxObserved = 0;
    for (const v of observedRemotes) {
      if (v > maxObserved) maxObserved = v;
    }

    // W39: bounds defense against runaway Lamports from untrusted replicas.
    // Use `Math.max(this.current, 1)` so boot (current=0) still accepts
    // reasonable first-remote values (1, 2) — otherwise `0 × 2 = 0` would
    // reject every non-zero remote.
    const bound = 2 * Math.max(this.current, 1);
    if (maxObserved > bound) {
      throw new SphereError(
        `Lamport.bumpFor: observed remote Lamport ${maxObserved} exceeds 2 × max(local=${this.current}, 1) = ${bound} (W39 bounds defense)`,
        'LAMPORT_BOUND_VIOLATION',
      );
    }

    const next = Math.max(this.current, maxObserved) + 1;
    this.current = next;
    return next;
  }

  /**
   * Returns the current Lamport value without mutating it. Useful for
   * passing to merge / serialization paths.
   */
  getCurrent(): number {
    return this.current;
  }

  /**
   * Rehydrate the clock from a set of TRUSTED local-store observations
   * (e.g. values read from our own previously-persisted entries on cold
   * restart). Sets `this.current = max(this.current, ...observed)`.
   *
   * **Distinction from {@link bumpFor}:** `bumpFor` treats inputs as
   * concurrent remote replicas subject to the W39 bounds defense
   * (`> 2 × max(this.current, 1)` rejects). That defense applies when
   * an OrbitDB replication channel could deliver values from untrusted
   * peers. It does NOT apply when a writer reads its OWN prior local
   * writes from durable storage on restart — those values are trusted
   * (they had to pass `bumpFor` when written) and may legitimately
   * exceed `2 × current=0`.
   *
   * **Why this method exists:** writers (e.g. {@link OutboxWriter},
   * {@link SentLedgerWriter}) prefix-scan their keyspace at write
   * time and feed every observed entry's `lamport` to `bumpFor`. On
   * cold restart with N≥3 prior writes the clock's `current` resets
   * to 0; the bounds defense then rejects every observation `> 2`.
   * Call `rehydrate(observed)` BEFORE the first `bumpFor` of each
   * write so the clock absorbs the prior state without bounds-checking
   * it.
   *
   * **Trust requirement:** caller MUST be passing values from a
   * locally-controlled store (the same OrbitDB the writer owns, AFTER
   * tombstone filtering / discriminator filtering). Do NOT call this
   * with values from a foreign-replica gossip channel — that's
   * `bumpFor`'s job.
   *
   * No-op when `observed` is empty.
   */
  rehydrate(observed: ReadonlyArray<number>): void {
    for (const v of observed) {
      if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0) {
        throw new SphereError(
          `Lamport.rehydrate: observed must be non-negative finite integers; got ${String(v)}`,
          'VALIDATION_ERROR',
        );
      }
      if (v > this.current) this.current = v;
    }
  }
}
