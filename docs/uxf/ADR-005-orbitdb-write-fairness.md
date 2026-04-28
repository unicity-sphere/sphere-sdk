# ADR-005: OrbitDB Write Fairness Cap and Queue

**Task**: T.5.B.0.5 (UXF-TRANSFER-IMPL-PLAN §T.5.B.0.5)
**Spec refs**: `docs/uxf/PROFILE-ARCHITECTURE.md` §10; `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §5.0, §5.5, §6.1
**Date**: 2026-04-28

## Status

**Accepted** with revisit criteria (see below). Lands BEFORE T.5.B/T.5.C
finalization-worker designs are frozen so they can compose against a
stable primitive.

## Context

The UXF inter-wallet transfer pipeline runs incoming bundles through a
worker pool (`MAX_INGEST_WORKERS = 16`, §5.0) and operates two
finalization-worker pools (T.5.B sender-side, T.5.C recipient-side) that
issue OrbitDB writes for the §5.5 step-5 "atomic-ish 4-step" sequence:
pool write proof → manifest CID rewrite → tombstone insert → queue-entry
removal. Under load every active worker can be racing toward an OrbitDB
key-value write at the same time.

OrbitDB writes are not free: each write competes with replication merges
arriving from peer replicas. With a 16-worker pool firing
simultaneously, three failure modes appear in informal load testing:

1. **Head-of-line blocking** — a slow merge starves all workers because
   the underlying OrbitDB log lock is contended.
2. **Merge thrashing** — replication backs up while workers monopolize
   the write path, so freshly-merged state is stale by the time a worker
   reads it for CAS.
3. **Tail-latency cliffs** — p99 latency spikes well past 5s when peer
   replicas reconnect and dump backed-up oplog entries while the worker
   pool is at full tilt.

The protocol does not require strict ordering across worker writes —
each step in §5.5 is idempotent on replay, and the §7 Lamport / §1.F
per-token-mutex disciplines preserve correctness — so the only knob we
need is **bounded concurrency**.

## Decision

1. Cap concurrent in-flight OrbitDB writes at
   `MAX_CONCURRENT_ORBITDB_WRITES = 8` (declared in
   `modules/payments/transfer/limits.ts`).
2. Implement the cap as a per-instance fairness queue in
   `profile/orbitdb-write-fairness.ts` (`class OrbitDbWriteFairness`)
   exposing `acquire / release / run / getMetrics`.
3. Fairness policy: **FIFO across pending writers** (round-robin). No
   priority lanes, no per-token-id buckets — the simplest discipline
   that prevents starvation under steady-state offered load.
4. T.5.B and T.5.C consume this primitive (added explicitly to their
   `depends_on`). T.6.A's outbox writer is intentionally NOT wrapped at
   this stage.

### Why 8 (half the worker pool)?

Setting the cap equal to `MAX_INGEST_WORKERS = 16` would let the worker
pool monopolize OrbitDB; replication merges would queue behind worker
writes and the system would converge to merge-thrashing under sustained
load. Setting the cap at 4 (a quarter) leaves too much CPU idle when
merges are quiescent. Half (8) is the conservative middle: workers can
make forward progress at maximum useful rate while leaving 50% headroom
for merges + GC + manifest-CID-rewrite reads.

This is a **design-time guess**, not a measured optimum. The revisit
criteria below force re-evaluation under T.8.E.1's load test before
T.8.D cutover.

## Consequences

- Writers may queue. Queue depth is observable via
  `OrbitDbWriteFairness.getMetrics()` (`inflightCount + waitQueueDepth`).
- Worst-case end-to-end latency of a §5.5 step-5 sequence grows by at
  most one queued write's wait time (queues are bounded by the worker
  pool size, not the offered request rate, because workers can only
  issue one write at a time).
- T.5.B and T.5.C can be tested independently of the queue (with
  `maxConcurrent = Infinity`-equivalent — pass a high number) and again
  with the production cap, so the queue is not a test-time hazard.
- The queue is per-instance: a destroy-recreate cycle reinitializes
  fresh state, so the slot accounting cannot leak across wallet
  incarnations.

## Revisit criteria

T.8.E.1's load test MUST measure and emit the fairness-queue metrics
(`inflightCount`, `waitQueueDepth`, p50/p99 wait time, p99 write
latency). Re-evaluate this ADR — and the cap value — if any of:

- (a) Sustained `waitQueueDepth / maxConcurrent > 0.5` for >30s under
  expected steady-state load.
- (b) p99 write latency exceeds 5s.
- (c) T.6.A's outbox writes are observed contending with T.5.B/T.5.C
  worker writes (i.e., outbox replicas show staleness symptoms while
  workers are saturated).

Any of those triggers either a cap-tuning PR or escalation to a
follow-up ADR (e.g., per-priority lanes, per-aggregator buckets).

## Out of scope

- **Per-priority queuing**. We have no current need to prioritize
  outbox writes over manifest writes; if (c) above fires, we can add a
  small two-lane queue without breaking the API surface.
- **T.6.A integration**. The outbox writer was designed before this
  primitive existed and uses unmediated OrbitDB writes. Wrapping it is
  a follow-up task `T.6.A-fairness-wrap` that is **NOT critical path**;
  it exists only if (c) above fires under T.8.E.1.
- **Cross-process fairness**. The queue is per-`Sphere`-instance.
  Multi-process wallets sharing one OrbitDB store are out of scope for
  v1.0.

## Alternatives considered

- **No cap** (status quo): rejected — informal load testing already
  shows merge-thrashing on 16 concurrent workers.
- **Cap at the OrbitDB-adapter layer** (`profile/orbitdb-adapter.ts`):
  rejected — couples fairness to the adapter implementation, making it
  hard to compose with future adapters or test-time fakes.
- **Token-bucket rate limiter**: rejected — rate-of-writes is not the
  pressure point; concurrency is. A token bucket adds a tuning knob
  (refill rate) without solving the merge-headroom problem.
