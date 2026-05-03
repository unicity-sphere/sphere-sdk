/**
 * UXF Transfer T.5.B.5 — coin-class cascade (§6.1.1).
 *
 * The coin path walks `splitParent` references transitively. Each child
 * is marked `manifest.status='invalid'` with `invalidReason='parent-rejected'`
 * via parent-flip-protected CAS. Outbox entries that referenced the
 * cascaded children receive `transfer:cascade-failed` events.
 *
 * Acceptance:
 *  - Single-level coin parent → cascade marks all direct children
 *    `parent-rejected`.
 *  - Transitive: grandchildren cascade too.
 *  - Outbox entries shipping cascaded children receive
 *    `transfer:cascade-failed` (one event per outbox).
 */

import { describe, expect, it } from 'vitest';

import {
  ADDR,
  buildWalker,
  makeFakeManifestStorage,
  makeFakeOutboxScanner,
  makeManifestEntry,
  makeOutboxEntry,
} from './cascade-walker-fixtures';

describe('§6.1.1 cascade — coin-class splitParent walk', () => {
  it('cascades to all direct coin children of a hard-failing parent', async () => {
    const PARENT = 'parent-coin';
    const C1 = 'child-1';
    const C2 = 'child-2';
    const C3 = 'child-3';

    const storage = makeFakeManifestStorage([
      // Parent is already marked invalid by T.5.B (oracle-rejected).
      {
        addr: ADDR,
        tokenId: PARENT,
        entry: makeManifestEntry({
          rootHashHex: 'aa'.repeat(32),
          status: 'invalid',
          invalidReason: 'oracle-rejected',
        }),
      },
      // Children with splitParent === PARENT — currently `pending`.
      {
        addr: ADDR,
        tokenId: C1,
        entry: makeManifestEntry({
          rootHashHex: 'b1'.repeat(32),
          status: 'pending',
          splitParent: PARENT,
        }),
      },
      {
        addr: ADDR,
        tokenId: C2,
        entry: makeManifestEntry({
          rootHashHex: 'b2'.repeat(32),
          status: 'pending',
          splitParent: PARENT,
        }),
      },
      {
        addr: ADDR,
        tokenId: C3,
        entry: makeManifestEntry({
          rootHashHex: 'b3'.repeat(32),
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

    expect(result.cascaded).toBe(3);
    expect(result.parentFlipAborted).toBe(0);
    expect(result.cycleDefenseFired).toBe(0);

    for (const child of [C1, C2, C3]) {
      const entry = await storage.readEntry(ADDR, child);
      expect(entry).toBeDefined();
      expect(entry!.status).toBe('invalid');
      expect(entry!.invalidReason).toBe('parent-rejected');
      expect(entry!.splitParent).toBe(PARENT);
    }
  });

  it('cascade is transitive: grandchildren also marked parent-rejected', async () => {
    const PARENT = 'p';
    const CHILD = 'c';
    const GRANDCHILD = 'gc';

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
      {
        addr: ADDR,
        tokenId: GRANDCHILD,
        entry: makeManifestEntry({
          rootHashHex: 'cc'.repeat(32),
          status: 'pending',
          splitParent: CHILD,
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

    expect(result.cascaded).toBe(2); // child + grandchild

    const childEntry = await storage.readEntry(ADDR, CHILD);
    expect(childEntry?.status).toBe('invalid');
    expect(childEntry?.invalidReason).toBe('parent-rejected');

    const grandEntry = await storage.readEntry(ADDR, GRANDCHILD);
    expect(grandEntry?.status).toBe('invalid');
    expect(grandEntry?.invalidReason).toBe('parent-rejected');
    // Grandchild's splitParent is preserved (CHILD), NOT overwritten to PARENT.
    expect(grandEntry?.splitParent).toBe(CHILD);
  });

  it('emits transfer:cascade-failed for outbox entries referencing cascaded children', async () => {
    const PARENT = 'parent-coin';
    const C1 = 'child-1';
    const C2 = 'child-2';

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
        tokenId: C1,
        entry: makeManifestEntry({
          rootHashHex: 'b1'.repeat(32),
          status: 'pending',
          splitParent: PARENT,
        }),
      },
      {
        addr: ADDR,
        tokenId: C2,
        entry: makeManifestEntry({
          rootHashHex: 'b2'.repeat(32),
          status: 'pending',
          splitParent: PARENT,
        }),
      },
    ]);

    const outbox = makeFakeOutboxScanner([
      makeOutboxEntry({
        id: 'ob-c1',
        tokenIds: [C1],
        recipientTransportPubkey: 'recv-1',
        bundleCid: 'cid-c1',
      }),
      makeOutboxEntry({
        id: 'ob-c2',
        tokenIds: [C2],
        recipientTransportPubkey: 'recv-2',
        bundleCid: 'cid-c2',
      }),
      // Unrelated outbox entry — should NOT receive a cascade event.
      makeOutboxEntry({
        id: 'ob-other',
        tokenIds: ['unrelated-token'],
        recipientTransportPubkey: 'recv-3',
      }),
    ]);

    const harness = buildWalker({
      storage,
      outbox,
      classes: { [PARENT]: 'coin' },
    });

    const result = await harness.walker.cascade(
      ADDR,
      PARENT,
      'oracle-rejected',
    );

    expect(result.cascaded).toBe(2);
    expect(result.outboxNotified).toBe(2);

    const cascadeEvents = harness.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(2);

    const outboxIdsEmitted = cascadeEvents
      .map((e) => (e.data as { outboxId: string }).outboxId)
      .sort();
    expect(outboxIdsEmitted).toEqual(['ob-c1', 'ob-c2']);
  });

  it('emits cascade-failed for non-instant outbox entries with silent:true (issue #167)', async () => {
    // Issue #167: historic behaviour silently dropped cascade-failed
    // events for non-instant outbox entries, leaving the recipient with
    // no signal that a forensically irrecoverable transfer happened.
    // The new contract: emit the event for ALL non-finalized/non-expired
    // entries; non-instant entries get `silent: true` and `mode: <mode>`
    // discriminators so UI can render a hard-error path.
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
    const outbox = makeFakeOutboxScanner([
      makeOutboxEntry({
        id: 'ob-conservative',
        tokenIds: [CHILD],
        mode: 'conservative',
      }),
      makeOutboxEntry({
        id: 'ob-instant',
        tokenIds: [CHILD],
        mode: 'instant',
      }),
    ]);

    const harness = buildWalker({
      storage,
      outbox,
      classes: { [PARENT]: 'coin' },
    });

    const result = await harness.walker.cascade(
      ADDR,
      PARENT,
      'oracle-rejected',
    );

    expect(result.cascaded).toBe(1);
    expect(result.outboxNotified).toBe(2); // BOTH entries notified
    expect(result.silentNotified).toBe(1); // conservative is silent

    const cascadeEvents = harness.events.events.filter(
      (e) => e.type === 'transfer:cascade-failed',
    );
    expect(cascadeEvents).toHaveLength(2);

    const byId = new Map<string, { mode?: string; silent?: boolean }>();
    for (const e of cascadeEvents) {
      const data = e.data as {
        readonly outboxId: string;
        readonly mode?: string;
        readonly silent?: boolean;
      };
      byId.set(data.outboxId, { mode: data.mode, silent: data.silent });
    }

    expect(byId.get('ob-instant')).toEqual({ mode: 'instant', silent: undefined });
    expect(byId.get('ob-conservative')).toEqual({
      mode: 'conservative',
      silent: true,
    });
  });

  it('idempotency: running cascade twice does not double-count or re-write', async () => {
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

    const r1 = await harness.walker.cascade(ADDR, PARENT, 'oracle-rejected');
    expect(r1.cascaded).toBe(1);

    const r2 = await harness.walker.cascade(ADDR, PARENT, 'oracle-rejected');
    // Second pass: child is already invalid/parent-rejected → idempotent
    // success without a re-write. Counter still increments because we
    // performed the no-op check successfully.
    expect(r2.cascaded).toBe(1);
    const childEntry = await storage.readEntry(ADDR, CHILD);
    expect(childEntry?.status).toBe('invalid');
  });
});
