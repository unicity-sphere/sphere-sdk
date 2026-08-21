// prewarmSend (§4): the confirm screen fetches the source blobs a send WOULD
// need, so the 3.4 s blob read that opens send() lands on the user's think-time
// instead of after the button. Measured on staging 2026-08-20: for a 54-source
// send, `getBlobs` cost 3.4 s of a 43.8 s wall clock.
//
// The property that makes reuse safe is state-scoping (F6): a warmed blob is
// keyed by the state its token sat at, so a token moved by an incoming claim or
// another device between confirm and send MISSES and is re-fetched. Serving a
// stale blob would put a spent state in the payload's `spentStates`.

import { afterEach, describe, expect, it } from 'vitest';

import { COIN, cleanupWorlds, makeWorld } from './facade-harness';

afterEach(cleanupWorlds);

/** Makes every source-blob read fail, so any read the send still needs is fatal. */
function forbidBlobReads(world: ReturnType<typeof makeWorld>, seen: string[][]): void {
  world.hooks.getBlobs = async (ids) => {
    seen.push(ids);
    throw new Error(`unexpected source-blob read: ${ids.join(',')}`);
  };
}

describe('PaymentsFacade — prewarmSend', () => {
  it('serves the warmed blobs to the send, so it reads no blob at all', async () => {
    const world = makeWorld();
    for (let i = 0; i < 4; i += 1) await world.seed(100n);
    await world.facade.start();

    await world.facade.prewarmSend({ recipient: '@peer', amount: '400', coinId: COIN });

    // The send must now be servable with storage switched off entirely. This is
    // the whole claim of the feature, and it fails loudly if the cache is
    // consulted with the wrong key or not at all.
    const seen: string[][] = [];
    forbidBlobReads(world, seen);
    const result = await world.facade.send({ recipient: '@peer', amount: '400', coinId: COIN });

    expect(result.tokenTransfers).toHaveLength(4);
    expect(seen).toEqual([]);
  });

  it('reserves nothing — a warmed plan that is never sent leaves the balance spendable', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();

    // Warm twice over the WHOLE balance: if previewSelection reserved, the second
    // call — and the send after it — would hit SEND_INSUFFICIENT_BALANCE.
    await world.facade.prewarmSend({ recipient: '@peer', amount: '100', coinId: COIN });
    await world.facade.prewarmSend({ recipient: '@peer', amount: '100', coinId: COIN });

    const assets = await world.facade.assets(COIN);
    expect(assets[0]?.totalAmount).toBe('100');
    expect(assets[0]?.tokenCount).toBe(1);

    const result = await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    expect(result.tokenTransfers).toHaveLength(1);
  });

  it('discardPrewarm drops the warmed blobs, so the send goes back to storage', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();

    await world.facade.prewarmSend({ recipient: '@peer', amount: '100', coinId: COIN });
    world.facade.discardPrewarm(); // the user backed out of confirm

    const seen: string[][] = [];
    forbidBlobReads(world, seen);
    await expect(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN })).rejects.toThrow(
      /unexpected source-blob read/
    );
    expect(seen).toHaveLength(1); // it really did try to re-read
  });

  it('never reuses a warmed blob across a second send — the warm set is single-use', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.seed(100n);
    await world.facade.start();

    await world.facade.prewarmSend({ recipient: '@peer', amount: '100', coinId: COIN });
    await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });

    // The second send was never warmed. Reusing anything here would mean serving
    // a blob whose freshness was established for a DIFFERENT send.
    const seen: string[][] = [];
    forbidBlobReads(world, seen);
    await expect(world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN })).rejects.toThrow(
      /unexpected source-blob read/
    );
  });

  it('warms nothing when the balance cannot cover the amount (no throw, no fetch)', async () => {
    const world = makeWorld();
    await world.seed(50n);
    await world.facade.start();

    const seen: string[][] = [];
    forbidBlobReads(world, seen);
    // A half-typed amount on the confirm screen must not explode or hit storage;
    // the real send is what reports SEND_INSUFFICIENT_BALANCE.
    await expect(world.facade.prewarmSend({ recipient: '@peer', amount: '999', coinId: COIN })).resolves
      .toBeUndefined();
    expect(seen).toEqual([]);
  });

  it('survives a storage failure while warming — the send still completes', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();

    world.hooks.getBlobs = async () => {
      throw new Error('storage down');
    };
    await expect(world.facade.prewarmSend({ recipient: '@peer', amount: '100', coinId: COIN })).resolves
      .toBeUndefined();

    delete world.hooks.getBlobs;
    const result = await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    expect(result.tokenTransfers).toHaveLength(1);
  });
});
