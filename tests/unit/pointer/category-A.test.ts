/**
 * Category A — Aggregator pointer publish-path conformance tests.
 *
 * Complements `tests/unit/profile/pointer/publish-algorithm.test.ts` by filling
 * in submit-path gaps (A1–A5 per PROFILE-AGGREGATOR-POINTER-TEST-SPEC.md §A,
 * interpreted at the unit-test layer against `publishOnceAtVersion`):
 *
 *   A1  happy-path single-attempt submit        — both sides SUCCESS
 *   A2  idempotent replay (H13 crash-retry)     — row 4 sub-case, marker not re-written
 *   A3  partial success                         — side SUCCESS + REQUEST_ID_EXISTS (row 2/3)
 *   A4  marker persistence across process boundary
 *                                               — fresh FlagStore resumes in-flight publish
 *   A5  cross-version isolation                  — v=1 submit inputs do not leak into v=2
 *
 * Uses the existing harness pattern from `publish-algorithm.test.ts`:
 *   - `makeDurableStore()`: in-memory kv with DURABLE_STORAGE marker
 *   - `makeInMemoryMutex()`:  simple test mutex (no file-lock I/O)
 *   - `buildFixtures()`:      masterKey / keyMaterial / signer / flagStore
 *   - `mockResp()` + `mockClient()`: programmable submitCommitment responders
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SubmitCommitmentResponse,
  SubmitCommitmentStatus,
} from '@unicitylabs/state-transition-sdk/lib/api/SubmitCommitmentResponse.js';
import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { Authenticator } from '@unicitylabs/state-transition-sdk/lib/api/Authenticator.js';
import type { DataHash } from '@unicitylabs/state-transition-sdk/lib/hash/DataHash.js';
import type { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId.js';

import {
  publishOnceAtVersion,
  FlagStore,
  DURABLE_STORAGE,
  derivePointerKeyMaterial,
  buildPointerSigner,
  createMasterPrivateKey,
  type PointerMutex,
  readMarker,
  writeMarker,
  computeCidHash,
} from '../../../profile/aggregator-pointer/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const WALLET_SEED = new Uint8Array(32).fill(0x42);
const CID_A = new Uint8Array([0x12, 0x20, ...new Array(32).fill(0xab)]);
// A second, distinguishable CID for cross-version / cid-mismatch scenarios.
// SHA-256 differs from CID_A by construction.
const CID_B = new Uint8Array([0x12, 0x20, ...new Array(32).fill(0xcd)]);

type KV = Map<string, string>;

/** Factory for an in-memory DurableStorageProvider (matches the existing harness). */
function makeDurableStore(kv: KV = new Map()) {
  return {
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: string) => { kv.set(k, v); },
    remove: async (k: string) => { kv.delete(k); },
    has: async (k: string) => kv.has(k),
    keys: async () => [...kv.keys()],
    clear: async () => { kv.clear(); },
    setIdentity: () => {},
    saveTrackedAddresses: async () => {},
    loadTrackedAddresses: async () => [],
    initialize: async () => {},
    shutdown: async () => {},
    name: 'test',
    [DURABLE_STORAGE]: true as const,
    // expose the underlying map for cross-instance sharing (A4).
    __kv: kv,
  };
}

async function buildFixtures(kv: KV = new Map()) {
  const masterKey = createMasterPrivateKey(WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  const storage = makeDurableStore(kv);
  const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);
  return { keyMaterial, signer, flagStore, storage, kv };
}

function mockResp(status: SubmitCommitmentStatus): SubmitCommitmentResponse {
  return new SubmitCommitmentResponse(status);
}

/**
 * Record-and-respond aggregator mock.
 *
 * Each call records `(requestId, transactionHash, authenticator)` in `captured`
 * and returns the response produced by `responder(i, args)` where `i` is the
 * 0-indexed call number. This lets a test both program the response sequence
 * and inspect the exact submission inputs after the fact (load-bearing for A5).
 */
interface CapturedCall {
  readonly i: number;
  readonly requestId: RequestId;
  readonly transactionHash: DataHash;
  readonly authenticator: Authenticator;
}

function mockClient(
  responder: (i: number, args: CapturedCall) => Promise<SubmitCommitmentResponse>,
  captured: CapturedCall[] = [],
): { client: AggregatorClient; captured: CapturedCall[] } {
  let nextI = 0;
  const client = {
    submitCommitment: vi.fn(
      async (requestId: RequestId, transactionHash: DataHash, authenticator: Authenticator) => {
        // Allocate the call index SYNCHRONOUSLY before awaiting any responder
        // — concurrent parallel submits (side A / side B) must get distinct
        // indices or they race and the `i === 0 ? SUCCESS : EXISTS` pattern
        // collapses to "both SUCCESS". This mirrors the `i++` post-increment
        // in the sibling harness (publish-algorithm.test.ts:68).
        const i = nextI;
        nextI += 1;
        const call: CapturedCall = { i, requestId, transactionHash, authenticator };
        captured.push(call);
        return responder(i, call);
      },
    ),
  } as unknown as AggregatorClient;
  return { client, captured };
}

/** In-memory mutex stub — matches the one in publish-algorithm.test.ts verbatim. */
function makeInMemoryMutex(): PointerMutex {
  let held = false;
  const queue: Array<() => void> = [];
  return {
    async acquire() {
      if (held) {
        await new Promise<void>((resolve) => queue.push(resolve));
      }
      held = true;
      return {
        release: async () => {
          held = false;
          const next = queue.shift();
          if (next) next();
        },
        assertHeld: () => {
          if (!held) throw new Error('fake mutex: lock lost');
        },
      };
    },
  };
}

// ── Shared test state ─────────────────────────────────────────────────────

describe('pointer publish — Category A (submit-path conformance)', () => {
  let fx: Awaited<ReturnType<typeof buildFixtures>>;
  let mutex: PointerMutex;
  let persistedVersion: number | null;
  let persistCalls: number;
  const persistLocalVersion = async (v: number) => {
    persistedVersion = v;
    persistCalls += 1;
  };

  beforeEach(async () => {
    fx = await buildFixtures();
    mutex = makeInMemoryMutex();
    persistedVersion = null;
    persistCalls = 0;
  });

  // ── A1 ────────────────────────────────────────────────────────────────

  it('A1: happy-path single-attempt publish — both sides SUCCESS, exactly one attempt × two sides', async () => {
    // Programmable responder returns SUCCESS for every call.
    const { client, captured } = mockClient(async () =>
      mockResp(SubmitCommitmentStatus.SUCCESS),
    );

    // Sanity: no marker before.
    expect(await readMarker(fx.flagStore)).toBeNull();

    const outcome = await publishOnceAtVersion({
      cidBytes: CID_A,
      candidateV: 1,
      currentLocalVersion: 0,
      keyMaterial: fx.keyMaterial,
      signer: fx.signer,
      aggregatorClient: client,
      flagStore: fx.flagStore,
      mutex,
      persistLocalVersion,
    });

    // Outcome shape: success, v=1, not idempotent (fresh publish, not a retry).
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.v).toBe(1);
      expect(outcome.idempotent).toBe(false);
    }

    // Exactly ONE attempt = exactly TWO submit calls (side A + side B in parallel).
    // This is the load-bearing A1 invariant: on happy path we do NOT retry.
    expect(client.submitCommitment).toHaveBeenCalledTimes(2);
    expect(captured.length).toBe(2);

    // §7.1.6 atomicity: localVersion persisted exactly once (at v=1), marker cleared.
    expect(persistedVersion).toBe(1);
    expect(persistCalls).toBe(1);
    expect(await readMarker(fx.flagStore)).toBeNull();

    // Cross-side distinctness: A and B produce different requestIds / transactionHashes.
    // (Defense-in-depth — key-derivation already tested per-side, but we guard against
    // accidental side=A reuse by the pointer layer here.)
    const reqIds = captured.map((c) => c.requestId.toString());
    const txHashes = captured.map((c) => c.transactionHash.toString());
    expect(new Set(reqIds).size).toBe(2);
    expect(new Set(txHashes).size).toBe(2);
  });

  // ── A2 ────────────────────────────────────────────────────────────────

  it('A2: idempotent replay (H13) — pre-existing marker + same cid → no duplicate marker write, idempotent=true', async () => {
    // Simulate crashed-but-durable state: the marker for (v=1, cid=CID_A) is
    // already persisted. On the next publishOnceAtVersion invocation with the
    // SAME cidBytes + candidateV, resolvePublishVersion MUST classify this
    // as an H13 idempotent retry (§7.1.4 Case 1) and MUST NOT re-write the
    // marker (§publish-algorithm row `!resolution.isIdempotentRetry`).
    await writeMarker(fx.flagStore, 1, CID_A);

    // Spy on flagStore.set to verify the marker is NOT re-written during the
    // idempotent path. Any call with localKey === 'pending_version' during
    // the publish attempt would indicate a regression of the idempotent gate.
    //
    // We spy AFTER the initial writeMarker above so it is not counted.
    const setSpy = vi.spyOn(fx.flagStore, 'set');

    // Responder: both sides return REQUEST_ID_EXISTS. Combined with the
    // `isIdempotentRetryHint=true` plumbed by publish-algorithm from
    // resolvePublishVersion, this maps to §7.3 row 4 → idempotent_replay.
    const { client, captured } = mockClient(async () =>
      mockResp(SubmitCommitmentStatus.REQUEST_ID_EXISTS),
    );

    const outcome = await publishOnceAtVersion({
      cidBytes: CID_A,
      candidateV: 1,
      currentLocalVersion: 0,
      keyMaterial: fx.keyMaterial,
      signer: fx.signer,
      aggregatorClient: client,
      flagStore: fx.flagStore,
      mutex,
      persistLocalVersion,
    });

    // Outcome: success via idempotent_replay path (both sides EXISTS, hint=true).
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.v).toBe(1);
      expect(outcome.idempotent).toBe(true);
    }

    // Core A2 invariant: the `pending_version` key was NOT written during
    // this publish — resolvePublishVersion's idempotent branch skipped the
    // marker-write (publish-algorithm.ts: `if (!resolution.isIdempotentRetry)`).
    const markerWrites = setSpy.mock.calls.filter(([k]) => k === 'pending_version');
    expect(markerWrites.length).toBe(0);
    setSpy.mockRestore();

    // Single-attempt discipline: two submit calls (one per side), no retries.
    expect(captured.length).toBe(2);

    // LocalVersion still persisted on success; marker cleared.
    expect(persistedVersion).toBe(1);
    expect(persistCalls).toBe(1);
    expect(await readMarker(fx.flagStore)).toBeNull();
  });

  // ── A3 ────────────────────────────────────────────────────────────────

  it('A3: partial success — side SUCCESS + side REQUEST_ID_EXISTS (§7.3 row 2/3) → idempotent success', async () => {
    // Scenario: one side was committed by a prior attempt (e.g., crashed
    // after submit-A ACK but before submit-B). A fresh publish now resubmits
    // both; the already-committed side returns REQUEST_ID_EXISTS while the
    // other still ingests cleanly with SUCCESS.
    //
    // SPEC §7.3 row 2 (A=SUCCESS, B=EXISTS) and row 3 (A=EXISTS, B=SUCCESS)
    // both resolve to `idempotent_replay` — the publish advances the same
    // version without burning a new one.
    //
    // The task brief labels this "publishing half succeeded, reconcile path
    // triggered" — at the submit-path layer this is NOT a conflict (row 5);
    // it is an idempotent success per the state-machine table. A row-5
    // conflict (both EXISTS, no idempotent hint, no marker match) is
    // already covered by the sibling test file.
    const { client, captured } = mockClient(async (i) =>
      // Parallel submit: call order is not guaranteed to be side-A first, but
      // classifySideResult is symmetric — we just need one SUCCESS and one EXISTS.
      mockResp(i === 0 ? SubmitCommitmentStatus.SUCCESS : SubmitCommitmentStatus.REQUEST_ID_EXISTS),
    );

    const outcome = await publishOnceAtVersion({
      cidBytes: CID_A,
      candidateV: 1,
      currentLocalVersion: 0,
      keyMaterial: fx.keyMaterial,
      signer: fx.signer,
      aggregatorClient: client,
      flagStore: fx.flagStore,
      mutex,
      persistLocalVersion,
    });

    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.v).toBe(1);
      // idempotent=true because one side was an EXISTS hit — the publish did
      // not write new content to that requestId, the aggregator returned its
      // existing commitment unchanged.
      expect(outcome.idempotent).toBe(true);
    }

    // Exactly two submit calls — no retry path, no network error.
    expect(captured.length).toBe(2);

    // LocalVersion persisted + marker cleared (success branch, §7.1.6).
    expect(persistedVersion).toBe(1);
    expect(persistCalls).toBe(1);
    expect(await readMarker(fx.flagStore)).toBeNull();
  });

  // ── A4 ────────────────────────────────────────────────────────────────

  it('A4: marker persistence across process boundary — fresh FlagStore observes pre-crash marker and recovers via H13', async () => {
    // Step 1 — "Process A": write a marker, then simulate SIGKILL (no mutex
    // release, no clearMarker, no localVersion persist). The marker is the
    // only durable artifact; backing storage survives.
    await writeMarker(fx.flagStore, 1, CID_A);

    // Capture the hex representation of the marker hash BEFORE re-init so we
    // can verify that the fresh FlagStore observes the same content.
    const expectedCidHash = computeCidHash(CID_A);

    // Step 2 — "Process B" boot: fresh FlagStore over the SAME underlying
    // kv map (simulates same data directory, new process). Re-derive every
    // ephemeral layer (keyMaterial, signer, flagStore, mutex) from the same
    // seed to model a real restart.
    const fxReboot = await buildFixtures(fx.kv);
    const rebootMutex = makeInMemoryMutex();
    const rebootPersisted: { v: number | null; calls: number } = { v: null, calls: 0 };
    const rebootPersist = async (v: number) => {
      rebootPersisted.v = v;
      rebootPersisted.calls += 1;
    };

    // Marker survived the process boundary.
    const observed = await readMarker(fxReboot.flagStore);
    expect(observed).not.toBeNull();
    expect(observed!.v).toBe(1);
    expect(observed!.cidHash.length).toBe(32);
    expect(Array.from(observed!.cidHash)).toEqual(Array.from(expectedCidHash));

    // Step 3 — resume publish with the SAME cidBytes. resolvePublishVersion
    // hits §7.1.4 Case 1 (marker.v === candidateV, cidHash match) and returns
    // `isIdempotentRetry: true`. publish-algorithm must NOT re-write the marker.
    const setSpy = vi.spyOn(fxReboot.flagStore, 'set');

    const { client, captured } = mockClient(async () =>
      mockResp(SubmitCommitmentStatus.REQUEST_ID_EXISTS),
    );

    const outcome = await publishOnceAtVersion({
      cidBytes: CID_A,
      candidateV: 1,
      currentLocalVersion: 0,
      keyMaterial: fxReboot.keyMaterial,
      signer: fxReboot.signer,
      aggregatorClient: client,
      flagStore: fxReboot.flagStore,
      mutex: rebootMutex,
      persistLocalVersion: rebootPersist,
    });

    // H13 recovery succeeded: both EXISTS + hint=true → idempotent_replay.
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.v).toBe(1);
      expect(outcome.idempotent).toBe(true);
    }

    // No duplicate marker-write on the idempotent-retry path (load-bearing).
    const markerWrites = setSpy.mock.calls.filter(([k]) => k === 'pending_version');
    expect(markerWrites.length).toBe(0);
    setSpy.mockRestore();

    // Post-recovery bookkeeping: localVersion advanced to 1, marker cleared.
    expect(rebootPersisted.v).toBe(1);
    expect(rebootPersisted.calls).toBe(1);
    expect(await readMarker(fxReboot.flagStore)).toBeNull();
    expect(captured.length).toBe(2);
  });

  // ── A5 ────────────────────────────────────────────────────────────────

  it('A5: cross-version isolation — v=1 requestIds / transactionHashes do not contaminate v=2', async () => {
    // Programmable responder: all SUCCESS, since we are testing INPUTS, not
    // aggregator state-machine branches.
    const { client, captured } = mockClient(async () =>
      mockResp(SubmitCommitmentStatus.SUCCESS),
    );

    // Publish at v=1 with CID_A.
    const outcome1 = await publishOnceAtVersion({
      cidBytes: CID_A,
      candidateV: 1,
      currentLocalVersion: 0,
      keyMaterial: fx.keyMaterial,
      signer: fx.signer,
      aggregatorClient: client,
      flagStore: fx.flagStore,
      mutex,
      persistLocalVersion,
    });
    expect(outcome1.kind).toBe('success');

    // Snapshot v=1 submission inputs (both sides).
    expect(captured.length).toBe(2);
    const v1Inputs = captured.slice(0, 2).map((c) => ({
      requestId: c.requestId.toString(),
      transactionHash: c.transactionHash.toString(),
    }));

    // Publish at v=2 with DIFFERENT cidBytes (CID_B). Marker/localVersion
    // must be clean state from the v=1 success (both tested in existing
    // happy-path; we rely on that here to isolate the cross-version claim).
    const outcome2 = await publishOnceAtVersion({
      cidBytes: CID_B,
      candidateV: 2,
      currentLocalVersion: 1,
      keyMaterial: fx.keyMaterial,
      signer: fx.signer,
      aggregatorClient: client,
      flagStore: fx.flagStore,
      mutex,
      persistLocalVersion,
    });
    expect(outcome2.kind).toBe('success');

    // Now 4 submits total: v=1 side A, v=1 side B, v=2 side A, v=2 side B.
    expect(captured.length).toBe(4);
    const v2Inputs = captured.slice(2, 4).map((c) => ({
      requestId: c.requestId.toString(),
      transactionHash: c.transactionHash.toString(),
    }));

    // Core A5 invariant: NO v=1 submission input is reused at v=2.
    // (Reuse would imply a derivation bug conflating the `v` parameter.)
    const v1RequestIds = new Set(v1Inputs.map((x) => x.requestId));
    const v1TxHashes = new Set(v1Inputs.map((x) => x.transactionHash));
    for (const input of v2Inputs) {
      expect(v1RequestIds.has(input.requestId)).toBe(false);
      expect(v1TxHashes.has(input.transactionHash)).toBe(false);
    }

    // Additionally: within v=2, the two sides produce distinct values
    // (catches a hypothetical bug collapsing side=A and side=B at v=2 only).
    expect(new Set(v2Inputs.map((x) => x.requestId)).size).toBe(2);
    expect(new Set(v2Inputs.map((x) => x.transactionHash)).size).toBe(2);

    // Version bookkeeping chained correctly.
    expect(persistedVersion).toBe(2);
    expect(persistCalls).toBe(2);
    expect(await readMarker(fx.flagStore)).toBeNull();
  });
});
