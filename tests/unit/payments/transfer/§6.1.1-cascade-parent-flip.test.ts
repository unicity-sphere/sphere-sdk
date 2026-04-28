/**
 * UXF Transfer T.5.B.5 — §6.1.1 parent-flip protection (W27).
 *
 * Per §6.1.1: between the time T.5.B emits `transfer:cascade-failed`
 * and the cascade walker reads the parent's manifest entry, an
 * `importInclusionProof()` override could have flipped the parent back
 * to `valid` (§6.3 stuck-PENDING escape hatch). The CAS-based child
 * write therefore re-reads the parent's manifest entry INSIDE the CAS
 * payload computation. If the parent is no longer `invalid`, the
 * cascade for that child is a no-op.
 *
 * This test exercises the deterministic-interleaving case: after the
 * walker reads the child but before the CAS commits, a concurrent
 * write flips the parent to `valid`. The walker MUST re-read the
 * parent inside the CAS payload computation and abort.
 *
 * Acceptance:
 *  - Parent flips during cascade → child is NOT marked invalid.
 *  - `parentFlipAborted` counter increments.
 *  - Recursion does NOT descend into the would-be cascaded child's
 *    children (their parent's now-valid status means the cascade is
 *    stale).
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  buildWalker,
  makeFakeManifestStorage,
  makeManifestEntry,
} from './cascade-walker-fixtures';

describe('§6.1.1 parent-flip protection (W27) — CAS re-reads parent', () => {
  it('parent flipped to valid before CAS payload read → child NOT invalidated', async () => {
    const PARENT = 'p';
    const CHILD = 'c';

    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: PARENT,
        entry: makeManifestEntry({
          rootHashHex: 'aa'.repeat(32),
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
      {
        addr: ADDR,
        tokenId: CHILD,
        entry: makeManifestEntry({
          rootHashHex: 'bb'.repeat(32),
          status: 'pending',
          splitParent: PARENT,
        }),
      },
    ]);

    // Deterministic interleaving: hook readEntry on the PARENT to flip
    // the parent's status to `valid` BEFORE returning the entry — but
    // ONLY when the read is happening inside the CAS payload (the
    // second parent read; the first read is from the cascade-root
    // class lookup path).
    //
    // A concurrent `importInclusionProof()` override has resolved the
    // parent's tx out-of-band. The W27 re-read inside the CAS payload
    // observes the now-valid parent and the cascade aborts.
    let parentReadCount = 0;
    const originalReadEntry = storage.readEntry.bind(storage);
    storage.readEntry = async (addr, tokenId) => {
      if (tokenId === PARENT) {
        parentReadCount++;
        // On the parent read inside the CAS payload (the first call
        // from `_cascadeChildWithParentFlipCheck`), the operator
        // override has just landed. Mutate before returning.
        if (parentReadCount === 1) {
          const current = storage.entries.get(`${ADDR}:${PARENT}`)!;
          storage.entries.set(`${ADDR}:${PARENT}`, {
            ...current,
            status: 'valid',
            invalidReason: undefined,
          });
        }
      }
      return originalReadEntry(addr, tokenId);
    };

    const harness = buildWalker({
      storage,
      classes: { [PARENT]: 'coin' },
    });

    const result = await harness.walker.cascade(
      ADDR,
      PARENT,
      'oracle-rejected',
    );

    // The child MUST NOT have been cascaded — the CAS payload read
    // observed the parent flip and aborted.
    expect(result.cascaded).toBe(0);
    expect(result.parentFlipAborted).toBeGreaterThanOrEqual(1);

    const childEntry = await storage.readEntry(ADDR, CHILD);
    expect(childEntry?.status).toBe('pending');
    expect(childEntry?.invalidReason).toBeUndefined();
  });

  it('parent-flip protection prevents recursion into the would-be cascaded child', async () => {
    // A → B → C; A is the failing parent. While the walker is
    // cascading B, the parent A flips to valid. The walker must
    // ABORT the cascade for B AND not descend into C (because B's
    // cascade is stale, so its children's cascade is also stale).
    const A = 'tok-a';
    const B = 'tok-b';
    const C = 'tok-c';

    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: A,
        entry: makeManifestEntry({
          rootHashHex: 'a1'.repeat(32),
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
      {
        addr: ADDR,
        tokenId: B,
        entry: makeManifestEntry({
          rootHashHex: 'b1'.repeat(32),
          status: 'pending',
          splitParent: A,
        }),
      },
      {
        addr: ADDR,
        tokenId: C,
        entry: makeManifestEntry({
          rootHashHex: 'c1'.repeat(32),
          status: 'pending',
          splitParent: B,
        }),
      },
    ]);

    // Deterministic interleaving: flip A's status BEFORE the CAS
    // payload read (parent-flip protection should observe valid).
    let aReadCount = 0;
    const originalReadEntry = storage.readEntry.bind(storage);
    storage.readEntry = async (addr, tokenId) => {
      if (tokenId === A) {
        aReadCount++;
        if (aReadCount === 1) {
          const current = storage.entries.get(`${ADDR}:${A}`)!;
          storage.entries.set(`${ADDR}:${A}`, {
            ...current,
            status: 'valid',
            invalidReason: undefined,
          });
        }
      }
      return originalReadEntry(addr, tokenId);
    };

    const harness = buildWalker({
      storage,
      classes: { [A]: 'coin' },
    });

    const result = await harness.walker.cascade(ADDR, A, 'oracle-rejected');

    expect(result.cascaded).toBe(0);
    expect(result.parentFlipAborted).toBeGreaterThanOrEqual(1);

    // C must NOT have been touched — B's cascade was aborted, so the
    // recursion into C never happened.
    const cEntry = await storage.readEntry(ADDR, C);
    expect(cEntry?.status).toBe('pending');
    expect(cEntry?.invalidReason).toBeUndefined();
  });

  it('parent stays invalid → cascade proceeds normally (negative control)', async () => {
    // No parent flip — verify the parent-flip-protected path STILL
    // succeeds when the parent remains invalid. This pins the negative
    // case so the CAS re-read doesn't accidentally always-abort.
    const PARENT = 'p';
    const CHILD = 'c';
    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: PARENT,
        entry: makeManifestEntry({
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
      {
        addr: ADDR,
        tokenId: CHILD,
        entry: makeManifestEntry({
          status: 'pending',
          splitParent: PARENT,
        }),
      },
    ]);
    const harness = buildWalker({
      storage,
      classes: { [PARENT]: 'coin' },
    });
    const result = await harness.walker.cascade(
      ADDR,
      PARENT,
      'oracle-rejected',
    );
    expect(result.cascaded).toBe(1);
    expect(result.parentFlipAborted).toBe(0);
  });
});
