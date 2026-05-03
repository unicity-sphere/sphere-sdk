/**
 * UXF Transfer T.5.D — `importInclusionProof()` per-tokenId mutex
 * (steelman post-cutover).
 *
 * Phase 7 steelman found that `importInclusionProof` had no per-tokenId
 * mutex. Two concurrent operator overrides on the same tokenId raced:
 * both read state, both passed case-5/6 split, both called
 * `applyOverride` — corrupting the manifest's audit trail OR re-queuing
 * duplicate entries.
 *
 * The fix wraps the read-decide-write body in
 * `perTokenMutex.acquire(tokenId, fn, { strategy })`. The default
 * `'cas'` strategy is the no-serialization pass-through (manifest CAS
 * inside the override callback handles concurrent writes); callers that
 * want strict single-flight pass `'rpc-release'` or `'bounded-hold'`.
 *
 * This test exercises the strict-serialization path so the assertion is
 * deterministic: two concurrent imports targeting the same tokenId
 * MUST see their override callbacks ordered by mutex acquisition.
 * Different tokenIds run in parallel.
 */

import { describe, expect, it } from 'vitest';

import { PerTokenMutex } from '../../../../profile/per-token-mutex';
import {
  ADDR,
  buildImporterHarness,
  invalidEntryFor,
  manifestEntryFor,
  proofFor,
  queueEntryFor,
  tk,
} from './import-inclusion-proof-fixtures';

describe('§6.3 importInclusionProof — per-tokenId mutex (steelman post-cutover)', () => {
  it('serializes two concurrent imports on the SAME tokenId (rpc-release)', async () => {
    // Resolver-controlled verify so we can deterministically interleave.
    let resolveFirstVerify!: () => void;
    const firstVerifyGate = new Promise<void>((r) => {
      resolveFirstVerify = r;
    });
    let verifyEntries = 0;

    const h = buildImporterHarness({
      mutexStrategy: 'rpc-release',
      verifyHook: async () => {
        verifyEntries++;
        if (verifyEntries === 1) {
          // First caller blocks inside verifyProof — the mutex is held
          // until this resolves. The second caller must NOT enter
          // verifyProof until then (else the mutex did not serialize).
          await firstVerifyGate;
        }
      },
    });

    h.disposition.entries.set(
      `${ADDR}.invalid.${tk('t-race')}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: tk('t-race'), reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(`${ADDR}:${tk('t-race')}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-race'),
      commitmentRequestId: 'rq-race',
      status: 'hard-fail',
    }));

    const p1 = h.importer.importInclusionProof(
      ADDR,
      tk('t-race'),
      proofFor({ requestId: 'rq-race' }),
      { allowInvalidOverride: true, currentTime: 1700000000001, operatorPubkey: 'op-A' },
    );
    // Yield to let p1 enter the mutex + verify gate. Several
    // microtask flushes are required because the importer awaits
    // `manifestStore.readEntry` and `_findInvalidEntry` (which itself
    // awaits the manifest read again) before reaching `verifyProof`.
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(verifyEntries).toBe(1);
    expect(h.mutex.isLocked(tk('t-race'))).toBe(true);

    // Kick off p2 while p1 is blocked. Under rpc-release, p2's verify
    // MUST NOT enter until p1 releases the mutex.
    const p2 = h.importer.importInclusionProof(
      ADDR,
      tk('t-race'),
      proofFor({ requestId: 'rq-race' }),
      { allowInvalidOverride: true, currentTime: 1700000000002, operatorPubkey: 'op-B' },
    );
    // Yield several microtask flushes — enough for p2 to reach
    // verifyProof IF the mutex were broken.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(verifyEntries).toBe(1); // p2 has NOT entered verifyProof yet.
    expect(h.overrideCalls.length).toBe(0);

    // Release p1. p2 should now proceed.
    resolveFirstVerify();
    const r1 = await p1;
    const r2 = await p2;

    // Both calls succeed; both override callbacks fire (this is the
    // race the steelman flagged). The point of the mutex is to make
    // the SEQUENCING deterministic — the audit trail / re-queue logic
    // then sees a consistent post-state from p1 before p2 runs. With
    // CAS the override callback's manifest write is the actual
    // mutual-exclusion point; with rpc-release the mutex itself
    // provides it. We assert both went through.
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(verifyEntries).toBe(2);
    expect(h.overrideCalls.length).toBe(2);
    // Ordering: p1's overrideCallback fired before p2's — the mutex
    // installed a happens-before edge between them.
    expect(h.overrideCalls[0]!.operatorPubkey).toBe('op-A');
    expect(h.overrideCalls[1]!.operatorPubkey).toBe('op-B');

    // Mutex is fully drained.
    expect(h.mutex.isLocked(tk('t-race'))).toBe(false);
    expect(h.mutex.size()).toBe(0);
  });

  it('does NOT serialize concurrent imports on DIFFERENT tokenIds (rpc-release)', async () => {
    // Both callers should be able to enter verifyProof concurrently
    // because the mutex is per-tokenId.
    let resolveFirstVerify!: () => void;
    const firstVerifyGate = new Promise<void>((r) => {
      resolveFirstVerify = r;
    });
    let verifyEntries = 0;

    const h = buildImporterHarness({
      mutexStrategy: 'rpc-release',
      verifyHook: async () => {
        verifyEntries++;
        if (verifyEntries === 1) {
          await firstVerifyGate;
        }
      },
    });

    for (const tokLabel of ['t-A', 't-B']) {
      const tok = tk(tokLabel);
      h.disposition.entries.set(
        `${ADDR}.invalid.${tok}.${'aa'.repeat(32)}`,
        invalidEntryFor({ tokenId: tok, reason: 'oracle-rejected' }),
      );
      h.manifest.entries.set(`${ADDR}:${tok}`, manifestEntryFor({
        status: 'invalid',
        invalidReason: 'oracle-rejected',
        rootHashHex: 'aa'.repeat(32),
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tok,
        commitmentRequestId: `rq-${tok}`,
        status: 'hard-fail',
      }));
    }

    const pA = h.importer.importInclusionProof(
      ADDR,
      tk('t-A'),
      proofFor({ requestId: `rq-${tk('t-A')}` }),
      { allowInvalidOverride: true, operatorPubkey: 'op-A' },
    );
    const pB = h.importer.importInclusionProof(
      ADDR,
      tk('t-B'),
      proofFor({ requestId: `rq-${tk('t-B')}` }),
      { allowInvalidOverride: true, operatorPubkey: 'op-B' },
    );
    // Flush microtasks — both should reach verifyProof immediately.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(verifyEntries).toBe(2);

    resolveFirstVerify();
    await pA;
    await pB;
    expect(h.mutex.size()).toBe(0);
  });

  it('default strategy (post #153) serializes concurrent imports on the SAME tokenId', async () => {
    // Per #153 the production default flipped from 'cas' to
    // 'rpc-release', so callers who DON'T pass an explicit strategy
    // get real per-tokenId serialization. This test omits
    // `mutexStrategy` from the harness — the importer's internal
    // default applies — and asserts the same serialization invariant
    // as the explicit-rpc-release test above.
    let resolveFirstVerify!: () => void;
    const firstVerifyGate = new Promise<void>((r) => {
      resolveFirstVerify = r;
    });
    let verifyEntries = 0;

    const h = buildImporterHarness({
      // No mutexStrategy passed — importer default ('rpc-release').
      verifyHook: async () => {
        verifyEntries++;
        if (verifyEntries === 1) {
          await firstVerifyGate;
        }
      },
    });

    h.disposition.entries.set(
      `${ADDR}.invalid.${tk('t-default')}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: tk('t-default'), reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(`${ADDR}:${tk('t-default')}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-default'),
      commitmentRequestId: 'rq-default-c',
      status: 'hard-fail',
    }));

    const p1 = h.importer.importInclusionProof(
      ADDR,
      tk('t-default'),
      proofFor({ requestId: 'rq-default-c' }),
      { allowInvalidOverride: true, operatorPubkey: 'op-A' },
    );
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(verifyEntries).toBe(1);
    expect(h.mutex.isLocked(tk('t-default'))).toBe(true);

    const p2 = h.importer.importInclusionProof(
      ADDR,
      tk('t-default'),
      proofFor({ requestId: 'rq-default-c' }),
      { allowInvalidOverride: true, operatorPubkey: 'op-B' },
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // p2 has NOT entered verifyProof — the default IS serializing.
    expect(verifyEntries).toBe(1);

    resolveFirstVerify();
    await p1;
    await p2;
    expect(verifyEntries).toBe(2);
    expect(h.mutex.size()).toBe(0);
  });

  it('CAS strategy (opt-in) is the no-serialization pass-through', async () => {
    // Under CAS the mutex does NOT serialize — verify both callers
    // enter verifyProof concurrently. Production correctness is
    // provided by ManifestCas inside the override callback, not by
    // the mutex. Per #153 the production default flipped from 'cas'
    // to 'rpc-release'; CAS is now opt-in and exercised here only to
    // confirm the legacy behaviour still applies when explicitly
    // selected.
    let resolveFirstVerify!: () => void;
    const firstVerifyGate = new Promise<void>((r) => {
      resolveFirstVerify = r;
    });
    let verifyEntries = 0;

    const h = buildImporterHarness({
      // Explicit opt-in to CAS — the production default is now
      // 'rpc-release' (#153) so we must select 'cas' to assert
      // pass-through behaviour.
      mutexStrategy: 'cas',
      verifyHook: async () => {
        verifyEntries++;
        if (verifyEntries === 1) {
          await firstVerifyGate;
        }
      },
    });

    h.disposition.entries.set(
      `${ADDR}.invalid.${tk('t-cas')}.${'aa'.repeat(32)}`,
      invalidEntryFor({ tokenId: tk('t-cas'), reason: 'oracle-rejected' }),
    );
    h.manifest.entries.set(`${ADDR}:${tk('t-cas')}`, manifestEntryFor({
      status: 'invalid',
      invalidReason: 'oracle-rejected',
      rootHashHex: 'aa'.repeat(32),
    }));
    h.queue.entries.push(queueEntryFor({
      tokenId: tk('t-cas'),
      commitmentRequestId: 'rq-cas',
      status: 'hard-fail',
    }));

    const p1 = h.importer.importInclusionProof(
      ADDR,
      tk('t-cas'),
      proofFor({ requestId: 'rq-cas' }),
      { allowInvalidOverride: true, operatorPubkey: 'op-A' },
    );
    const p2 = h.importer.importInclusionProof(
      ADDR,
      tk('t-cas'),
      proofFor({ requestId: 'rq-cas' }),
      { allowInvalidOverride: true, operatorPubkey: 'op-B' },
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // CAS == pass-through: both verify entries observed concurrently.
    expect(verifyEntries).toBe(2);

    resolveFirstVerify();
    await p1;
    await p2;
    // CAS does not track inflight slots — size stays 0 throughout.
    expect(h.mutex.size()).toBe(0);
  });

  it('shared mutex across multiple imports preserves the per-tokenId chain', async () => {
    // Inject a single mutex shared across two harnesses (mimicking the
    // production wiring where the recipient/sender finalization
    // workers share a mutex with the importer).
    const sharedMutex = new PerTokenMutex();

    let resolveFirstVerify!: () => void;
    const firstVerifyGate = new Promise<void>((r) => {
      resolveFirstVerify = r;
    });
    let verifyEntries = 0;

    const h1 = buildImporterHarness({
      mutex: sharedMutex,
      mutexStrategy: 'rpc-release',
      verifyHook: async () => {
        verifyEntries++;
        if (verifyEntries === 1) {
          await firstVerifyGate;
        }
      },
    });
    const h2 = buildImporterHarness({
      mutex: sharedMutex,
      mutexStrategy: 'rpc-release',
      verifyHook: async () => {
        verifyEntries++;
      },
    });

    for (const h of [h1, h2]) {
      h.disposition.entries.set(
        `${ADDR}.invalid.${tk('t-shared')}.${'aa'.repeat(32)}`,
        invalidEntryFor({ tokenId: tk('t-shared'), reason: 'oracle-rejected' }),
      );
      h.manifest.entries.set(`${ADDR}:${tk('t-shared')}`, manifestEntryFor({
        status: 'invalid',
        invalidReason: 'oracle-rejected',
        rootHashHex: 'aa'.repeat(32),
      }));
      h.queue.entries.push(queueEntryFor({
        tokenId: tk('t-shared'),
        commitmentRequestId: 'rq-shared',
        status: 'hard-fail',
      }));
    }

    const p1 = h1.importer.importInclusionProof(
      ADDR,
      tk('t-shared'),
      proofFor({ requestId: 'rq-shared' }),
      { allowInvalidOverride: true, operatorPubkey: 'op-1' },
    );
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(verifyEntries).toBe(1);
    expect(sharedMutex.isLocked(tk('t-shared'))).toBe(true);

    const p2 = h2.importer.importInclusionProof(
      ADDR,
      tk('t-shared'),
      proofFor({ requestId: 'rq-shared' }),
      { allowInvalidOverride: true, operatorPubkey: 'op-2' },
    );
    for (let i = 0; i < 10; i++) await Promise.resolve();
    // h2's verify is gated by the shared mutex held by h1.
    expect(verifyEntries).toBe(1);

    resolveFirstVerify();
    await p1;
    await p2;
    expect(verifyEntries).toBe(2);
    expect(sharedMutex.size()).toBe(0);
  });
});
