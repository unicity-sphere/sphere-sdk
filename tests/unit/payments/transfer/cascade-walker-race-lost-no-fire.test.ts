/**
 * UXF Transfer T.5.B.5 — race-lost EXCEPTION (§6.1.1).
 *
 * Per §6.1.1, when the queue entry hard-fails with reason='race-lost',
 * the cascade does NOT fire — the source token is genuinely valid (the
 * race-winner's tx is on-chain), and the recipient never received our
 * bundle. Only the outbox entry transitions to `failed-permanent`; the
 * source token's local state is untouched. This is unique to race-lost;
 * all other hard-fail reasons trigger the cascade.
 *
 * Acceptance:
 *  - reason='race-lost' → walker returns early; no cascade fires.
 *  - No manifest writes are performed.
 *  - No transfer:cascade-failed events are emitted.
 *  - This holds for BOTH coin-class and NFT-class parents (the early
 *    return short-circuits before the class lookup).
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

describe("§6.1.1 race-lost exception — cascade does NOT fire", () => {
  it('race-lost on coin parent → no cascade, no manifest writes, no events', async () => {
    const PARENT = 'p';
    const CHILD = 'c';

    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: PARENT,
        entry: makeManifestEntry({
          status: 'invalid',
          invalidReason: 'race-lost',
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

    const outbox = makeFakeOutboxScanner([
      makeOutboxEntry({ id: 'ob', tokenIds: [CHILD] }),
    ]);

    const harness = buildWalker({
      storage,
      outbox,
      classes: { [PARENT]: 'coin' },
    });

    const result = await harness.walker.cascade(ADDR, PARENT, 'race-lost');

    expect(result.cascaded).toBe(0);
    expect(result.nftNotified).toBe(0);
    expect(result.outboxNotified).toBe(0);
    expect(result.parentFlipAborted).toBe(0);
    expect(result.cycleDefenseFired).toBe(0);

    // Child's status MUST be unchanged.
    const childEntry = await storage.readEntry(ADDR, CHILD);
    expect(childEntry?.status).toBe('pending');
    expect(childEntry?.invalidReason).toBeUndefined();

    // No events emitted.
    const events = harness.events.events;
    expect(events).toHaveLength(0);
  });

  it('race-lost on NFT parent → no outbox notification (race-lost takes precedence)', async () => {
    const NFT = 'nft-1';
    const storage = makeFakeManifestStorage([
      {
        addr: ADDR,
        tokenId: NFT,
        entry: makeManifestEntry({
          status: 'invalid',
          invalidReason: 'race-lost',
        }),
      },
    ]);
    const outbox = makeFakeOutboxScanner([
      makeOutboxEntry({ id: 'ob', tokenIds: [NFT] }),
    ]);

    const harness = buildWalker({
      storage,
      outbox,
      classes: { [NFT]: 'nft' },
    });

    const result = await harness.walker.cascade(ADDR, NFT, 'race-lost');

    expect(result.cascaded).toBe(0);
    expect(result.nftNotified).toBe(0);
    expect(harness.events.events).toHaveLength(0);
  });

  it('race-lost short-circuits BEFORE the class lookup (no I/O at all)', async () => {
    // The early return MUST fire before classifyToken is invoked. We
    // inject a classifyToken stub that throws if called; if the early
    // return is missing, the throw surfaces; if present, the walker
    // returns cleanly.
    let classifyCalls = 0;
    const harness = buildWalker({
      classifyToken: async () => {
        classifyCalls++;
        throw new Error('classifyToken should NOT be called on race-lost');
      },
    });

    const result = await harness.walker.cascade(ADDR, 'any', 'race-lost');

    expect(classifyCalls).toBe(0);
    expect(result.cascaded).toBe(0);
  });

  it('NON-race-lost reasons DO fire cascade (regression check)', async () => {
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

    const r1 = await harness.walker.cascade(
      ADDR,
      PARENT,
      'oracle-rejected',
    );
    expect(r1.cascaded).toBe(1);

    // Reset and try belief-divergence.
    storage.entries.set(`${ADDR}:${CHILD}`, {
      ...storage.entries.get(`${ADDR}:${CHILD}`)!,
      status: 'pending',
      invalidReason: undefined,
    });
    storage.entries.set(`${ADDR}:${PARENT}`, {
      ...storage.entries.get(`${ADDR}:${PARENT}`)!,
      invalidReason: 'belief-divergence',
    });
    harness.events.clear();

    const r2 = await harness.walker.cascade(
      ADDR,
      PARENT,
      'belief-divergence',
    );
    expect(r2.cascaded).toBe(1);

    // proof-invalid also fires.
    storage.entries.set(`${ADDR}:${CHILD}`, {
      ...storage.entries.get(`${ADDR}:${CHILD}`)!,
      status: 'pending',
      invalidReason: undefined,
    });
    storage.entries.set(`${ADDR}:${PARENT}`, {
      ...storage.entries.get(`${ADDR}:${PARENT}`)!,
      invalidReason: 'proof-invalid',
    });
    const r3 = await harness.walker.cascade(ADDR, PARENT, 'proof-invalid');
    expect(r3.cascaded).toBe(1);
  });
});
