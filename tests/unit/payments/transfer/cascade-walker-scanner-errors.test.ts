/**
 * UXF Transfer T.5.B.5 — scanner-error surfacing (steelman fix Wave 3 #170).
 *
 * Historic behaviour swallowed `findChildren` failures with a bare `catch {}`
 * — the cascade aborted the failing branch with NO counter increment, NO
 * event, NO log. Operator could only recover via a later
 * `revalidateCascadedChildren()` invocation, but had no signal the original
 * cascade missed children. A flaky OrbitDB read mid-cascade left a coin
 * token's children un-cascaded; the child remained `valid` while the parent
 * was `_invalid` — a silent security regression because cascade is the
 * load-bearing defense against parent-recipient-rejected token spending.
 *
 * Acceptance:
 *  - `manifestScanner.findChildren()` throws → `scannerErrors` increments.
 *  - The `onScannerError` callback fires with `phase: 'find-children'`,
 *    addr, tokenId, and the error reference.
 *  - `outboxScanner.findEntriesByTokenId()` throws → `scannerErrors`
 *    increments AND `phase: 'find-outbox-entries'`.
 *  - The branch IS aborted but the cascade for SIBLING branches continues.
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  buildWalker,
  makeFakeManifestStorage,
  makeFakeManifestScanner,
  makeFakeOutboxScanner,
  makeManifestEntry,
  makeOutboxEntry,
} from './cascade-walker-fixtures';
import type {
  CascadeManifestScanner,
  CascadeOutboxScanner,
} from '../../../../modules/payments/transfer/cascade-walker';
import type { UxfTransferOutboxEntry } from '../../../../types/uxf-outbox';

describe('§6.1.1 cascade — scanner-error surfacing', () => {
  it('findChildren throw → scannerErrors increments + onScannerError fires', async () => {
    const PARENT = 'p';
    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: PARENT,
        entry: makeManifestEntry({
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
    ]);

    const boom = new Error('orbitdb read failed');
    const failingScanner: CascadeManifestScanner = {
      readEntry: makeFakeManifestScanner(storage).readEntry,
      async findChildren(_addr, _parent) {
        throw boom;
      },
    };

    const harness = buildWalker({
      storage,
      manifestScanner: failingScanner,
      classes: { [PARENT]: 'coin' },
    });

    const result = await harness.walker.cascade(
      ADDR,
      PARENT,
      'oracle-rejected',
    );

    // Counter surfaced.
    expect(result.scannerErrors).toBe(1);
    // Cascade did not silently succeed — no children were processed.
    expect(result.cascaded).toBe(0);

    // Callback fired with full forensic context.
    expect(harness.scannerErrors).toHaveLength(1);
    expect(harness.scannerErrors[0].phase).toBe('find-children');
    expect(harness.scannerErrors[0].addr).toBe(ADDR);
    expect(harness.scannerErrors[0].tokenId).toBe(PARENT);
    expect(harness.scannerErrors[0].error).toBe(boom);
  });

  it('findChildren throw mid-recursion → branch aborted, sibling continues', async () => {
    // Parent has 2 children. After cascading C1 successfully we recurse
    // into C1. findChildren(C1) throws. Recursion stops for C1's branch
    // but the outer loop continues to C2 normally.
    //
    // To set this up we fail findChildren(C1) deterministically while
    // returning [C1, C2] for findChildren(PARENT) and [] for everyone
    // else.
    const PARENT = 'p';
    const C1 = 'c1';
    const C2 = 'c2';

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
        tokenId: C1,
        entry: makeManifestEntry({
          rootHashHex: '01'.repeat(32),
          status: 'pending',
          splitParent: PARENT,
        }),
      },
      {
        addr: ADDR,
        tokenId: C2,
        entry: makeManifestEntry({
          rootHashHex: '02'.repeat(32),
          status: 'pending',
          splitParent: PARENT,
        }),
      },
    ]);

    const baseScanner = makeFakeManifestScanner(storage);
    const partialFailingScanner: CascadeManifestScanner = {
      readEntry: baseScanner.readEntry,
      async findChildren(addr, parent) {
        if (parent === C1) throw new Error('findChildren(C1) flake');
        return baseScanner.findChildren(addr, parent);
      },
    };

    const harness = buildWalker({
      storage,
      manifestScanner: partialFailingScanner,
      classes: { [PARENT]: 'coin' },
    });

    const result = await harness.walker.cascade(
      ADDR,
      PARENT,
      'oracle-rejected',
    );

    // Both children cascaded successfully (the failure is on C1's
    // grandchildren branch, not on cascading C1 itself).
    expect(result.cascaded).toBe(2);
    // One scanner error: findChildren(C1).
    expect(result.scannerErrors).toBe(1);
    expect(harness.scannerErrors).toHaveLength(1);
    expect(harness.scannerErrors[0].tokenId).toBe(C1);
    expect(harness.scannerErrors[0].phase).toBe('find-children');

    // C1 and C2 both invalid now.
    expect((await storage.readEntry(ADDR, C1))?.status).toBe('invalid');
    expect((await storage.readEntry(ADDR, C2))?.status).toBe('invalid');
  });

  it('outbox scanner throw → scannerErrors increments with find-outbox-entries phase', async () => {
    const PARENT = 'p';
    const C1 = 'c1';
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
        tokenId: C1,
        entry: makeManifestEntry({
          rootHashHex: '01'.repeat(32),
          status: 'pending',
          splitParent: PARENT,
        }),
      },
    ]);

    const boom = new Error('outbox storage failed');
    const failingOutbox: CascadeOutboxScanner = {
      async findEntriesByTokenId(_tokenId) {
        throw boom;
      },
    };

    const harness = buildWalker({
      storage,
      outboxScanner: failingOutbox,
      classes: { [PARENT]: 'coin' },
    });

    const result = await harness.walker.cascade(
      ADDR,
      PARENT,
      'oracle-rejected',
    );

    // Cascade itself succeeded (C1 marked invalid) — outbox scan failed.
    expect(result.cascaded).toBe(1);
    expect(result.outboxNotified).toBe(0);
    expect(result.scannerErrors).toBe(1);

    expect(harness.scannerErrors).toHaveLength(1);
    expect(harness.scannerErrors[0].phase).toBe('find-outbox-entries');
    expect(harness.scannerErrors[0].tokenId).toBe(C1);
    expect(harness.scannerErrors[0].error).toBe(boom);
  });

  it('NFT path outbox scanner throw → scannerErrors increments', async () => {
    const NFT = 'nft-1';
    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: NFT,
        entry: makeManifestEntry({
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
    ]);
    const failingOutbox: CascadeOutboxScanner = {
      async findEntriesByTokenId(_tokenId) {
        throw new Error('outbox flake');
      },
    };

    const harness = buildWalker({
      storage,
      outboxScanner: failingOutbox,
      classes: { [NFT]: 'nft' },
    });

    const result = await harness.walker.cascade(ADDR, NFT, 'oracle-rejected');

    expect(result.scannerErrors).toBe(1);
    expect(result.nftNotified).toBe(0);
    expect(harness.scannerErrors).toHaveLength(1);
    expect(harness.scannerErrors[0].phase).toBe('find-outbox-entries');
    expect(harness.scannerErrors[0].tokenId).toBe(NFT);
  });

  it('onScannerError callback throwing does NOT abort the cascade', async () => {
    // Defensive: a faulty alert pipeline must not poison the cascade.
    const PARENT = 'p';
    const C1 = 'c1';
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
        tokenId: C1,
        entry: makeManifestEntry({
          rootHashHex: '01'.repeat(32),
          status: 'pending',
          splitParent: PARENT,
        }),
      },
    ]);
    const boom = new Error('outbox flake');
    const failingOutbox: CascadeOutboxScanner = {
      async findEntriesByTokenId(_tokenId) {
        throw boom;
      },
    };

    // Build the walker WITHOUT the harness's scannerErrors recorder —
    // we inject our own onScannerError that throws.
    const harness = buildWalker({
      storage,
      outboxScanner: failingOutbox,
      classes: { [PARENT]: 'coin' },
    });

    // Replace the walker with one whose onScannerError throws.
    const { CascadeWalker } = await import(
      '../../../../modules/payments/transfer/cascade-walker'
    );
    const { ManifestCas } = await import(
      '../../../../profile/manifest-cas'
    );
    const walker = new CascadeWalker({
      manifestScanner: makeFakeManifestScanner(storage),
      manifestCas: new ManifestCas(storage),
      outboxScanner: failingOutbox,
      classifyToken: async (_a, t) => (t === PARENT ? 'coin' : null),
      emit: () => {},
      onScannerError: () => {
        throw new Error('alert pipeline crashed');
      },
    });

    // Should not throw — onScannerError exception caught defensively.
    const result = await walker.cascade(ADDR, PARENT, 'oracle-rejected');
    expect(result.scannerErrors).toBe(1);
    expect(result.cascaded).toBe(1);
    void harness; // silence unused-var
  });
});

describe('§6.1.1 cascade — parent-flipped CAS abort does NOT mark child visited', () => {
  it('child re-cascades when parent flips back to invalid in a subsequent walk', async () => {
    // Setup: PARENT is invalid, CHILD has splitParent=PARENT and is
    // pending. We use a storage write-tap to mid-cascade flip the
    // PARENT to `valid` BEFORE the CAS reads it — this triggers the
    // 'parent-flipped' abort. We then flip the parent BACK to
    // `invalid` and re-run cascade — the child MUST be re-cascaded
    // (i.e. NOT marked visited from the prior aborted attempt).
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

    // Flip the parent to `valid` BEFORE the cascade reads it (i.e.
    // simulate `importInclusionProof()` arriving racing with the
    // cascade walk). We do this by replacing the manifest scanner's
    // readEntry to return `valid` for PARENT during the first
    // cascade walk only.
    const baseScanner = makeFakeManifestScanner(storage);
    let parentReadCount = 0;
    const flippedThenRevertedScanner: CascadeManifestScanner = {
      async readEntry(addr, tokenId) {
        if (tokenId === PARENT) {
          parentReadCount++;
          // Return 'valid' for the FIRST read of PARENT inside the
          // cascade walk (which triggers parent-flipped abort).
          if (parentReadCount === 1) {
            return {
              ...(await baseScanner.readEntry(addr, tokenId)),
              status: 'valid',
            } as Awaited<ReturnType<CascadeManifestScanner['readEntry']>>;
          }
        }
        return baseScanner.readEntry(addr, tokenId);
      },
      findChildren: baseScanner.findChildren,
    };

    const harness1 = buildWalker({
      storage,
      manifestScanner: flippedThenRevertedScanner,
      classes: { [PARENT]: 'coin' },
    });

    const r1 = await harness1.walker.cascade(
      ADDR,
      PARENT,
      'oracle-rejected',
    );

    // First walk: parent appeared `valid` so the CAS aborted with
    // 'parent-flipped'. Child NOT cascaded.
    expect(r1.parentFlipAborted).toBe(1);
    expect(r1.cascaded).toBe(0);

    // Verify the child manifest entry is unchanged (still pending).
    const childAfterFirstWalk = await storage.readEntry(ADDR, CHILD);
    expect(childAfterFirstWalk?.status).toBe('pending');

    // Now run the cascade AGAIN with a CLEAN scanner that returns the
    // real parent state (which is still 'invalid' in storage). The
    // child MUST be re-cascaded — i.e. the prior 'parent-flipped'
    // abort did NOT permanently mark it visited.
    const harness2 = buildWalker({
      storage,
      manifestScanner: makeFakeManifestScanner(storage),
      classes: { [PARENT]: 'coin' },
    });

    const r2 = await harness2.walker.cascade(
      ADDR,
      PARENT,
      'oracle-rejected',
    );

    expect(r2.cascaded).toBe(1); // child WAS re-cascaded
    expect(r2.parentFlipAborted).toBe(0);

    const childFinal = await storage.readEntry(ADDR, CHILD);
    expect(childFinal?.status).toBe('invalid');
    expect(childFinal?.invalidReason).toBe('parent-rejected');
  });

  it('within a single cascade, parent-flipped child is NOT marked visited', async () => {
    // Inspection-only test: build a fixture where child A's CAS aborts
    // with 'parent-flipped' but child B (sibling) cascades successfully.
    // Then build a SECOND child B' that has splitParent=A. If A had
    // been marked visited from the abort, walking B's children would
    // not re-encounter A — but B's children don't include A, so the
    // visited mark is invisible. Instead we verify the OUTPUT of the
    // cascade: A's outbox notification did NOT fire (because the CAS
    // aborted), but B's did. Re-cascading via a fresh walker run with
    // the SAME storage state would re-attempt A — verified by the
    // previous test.
    //
    // Here we focus on the COUNTER state and EVENT emissions, asserting
    // that no outbox events fire for A in a single cascade walk.
    const PARENT = 'p';
    const A = 'child-a';
    const B = 'child-b';

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
        tokenId: A,
        entry: makeManifestEntry({
          rootHashHex: 'a1'.repeat(32),
          status: 'pending',
          splitParent: PARENT,
        }),
      },
      {
        addr: ADDR,
        tokenId: B,
        entry: makeManifestEntry({
          rootHashHex: 'b1'.repeat(32),
          status: 'pending',
          splitParent: PARENT,
        }),
      },
    ]);

    const outbox = makeFakeOutboxScanner([
      makeOutboxEntry({ id: 'ob-A', tokenIds: [A] }) as UxfTransferOutboxEntry,
      makeOutboxEntry({ id: 'ob-B', tokenIds: [B] }) as UxfTransferOutboxEntry,
    ]);

    // Flip parent to 'valid' ONLY when A's cascade attempts to read
    // it (the very first parent read inside the CAS). Subsequent
    // parent reads (for B's CAS) see 'invalid'.
    const baseScanner = makeFakeManifestScanner(storage);
    let parentReadCount = 0;
    const onceFlipScanner: CascadeManifestScanner = {
      async readEntry(addr, tokenId) {
        if (tokenId === PARENT) {
          parentReadCount++;
          if (parentReadCount === 1) {
            return {
              ...(await baseScanner.readEntry(addr, tokenId)),
              status: 'valid',
            } as Awaited<ReturnType<CascadeManifestScanner['readEntry']>>;
          }
        }
        return baseScanner.readEntry(addr, tokenId);
      },
      findChildren: baseScanner.findChildren,
    };

    const harness = buildWalker({
      storage,
      outbox,
      manifestScanner: onceFlipScanner,
      classes: { [PARENT]: 'coin' },
    });

    const r = await harness.walker.cascade(ADDR, PARENT, 'oracle-rejected');

    // A's CAS aborted with parent-flipped, B's succeeded.
    expect(r.parentFlipAborted).toBe(1);
    expect(r.cascaded).toBe(1);

    // Only B's outbox entry was notified.
    const outboxIds = harness.events.events
      .filter((e) => e.type === 'transfer:cascade-failed')
      .map((e) => (e.data as { outboxId: string }).outboxId);
    expect(outboxIds).toEqual(['ob-B']);

    // A is still pending in storage (no successful cascade write).
    expect((await storage.readEntry(ADDR, A))?.status).toBe('pending');
    expect((await storage.readEntry(ADDR, B))?.status).toBe('invalid');
  });
});
