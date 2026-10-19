/**
 * #840, through the composed PaymentsFacade: a cancel the server never stored (its abort
 * answers 404 NOT_FOUND) keeps its tombstone while a settling link still names it. The
 * facade must hand the converger its own Requests' links; the converger-level suites wire
 * that set by hand, so only this suite sees the facade's wiring.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createMachineStores } from '../../../modules/payments-v2/machine/journal';
import { STORE_KEYS } from '../../../modules/payments-v2/stores';
import { cleanupWorlds, makeWorld, type World } from './facade-harness';

afterEach(async () => {
  await cleanupWorlds();
});

const NEVER_STORED = 'never-stored';

async function linkedNeverStoredCancel(w: World): Promise<void> {
  await createMachineStores(w.kv).backstop.upsert({
    transferId: NEVER_STORED,
    payloadEnvelope: 'enc:unread',
    requiresSeedClose: false,
    disposition: 'abortPending',
    createdAt: 1,
  });
  const link = { requestId: 'r1', transferId: NEVER_STORED, committed: false, createdAt: 1 };
  await w.kv.set(STORE_KEYS.settlingLinks, { r1: link });
}

function recordResponses(w: World, responded: unknown[]): void {
  w.innerClient.respondPaymentRequest = async (id, response) => {
    responded.push({ id, response });
    throw new Error('the test never expects a respond');
  };
}

/** The settling journal's first read fails, so the facade's Requests fails open to an empty journal. */
function failFirstJournalRead(w: World): void {
  const get = w.kv.get.bind(w.kv);
  let transient = true;
  w.kv.get = async <T>(key: string): Promise<T | null> => {
    if (transient && key === STORE_KEYS.settlingLinks) {
      transient = false;
      throw new Error('injected transient read failure');
    }
    return get<T>(key);
  };
}

describe('the facade keeps a never-stored cancel while its own settling link names it (#840)', () => {
  it('a settling journal that failed open keeps the tombstone, and the next session reverts the link, never paid', async () => {
    const w = makeWorld();
    await linkedNeverStoredCancel(w);
    const responded: unknown[] = [];
    recordResponses(w, responded);
    failFirstJournalRead(w);

    await w.facade.start();
    await w.facade.resumeNow();

    const stores = createMachineStores(w.kv);
    expect(await stores.backstop.getByKey(NEVER_STORED), 'the link is still on disk').toBeDefined();

    await w.facade.stop();
    const restarted = makeWorld({ restartOf: w });
    recordResponses(restarted, responded);
    await restarted.facade.start();
    await restarted.facade.resumeNow();
    await restarted.facade.resumeNow();

    expect(responded, 'nothing moved: the request must never be responded paid').toEqual([]);
    expect(w.kv.map.get(STORE_KEYS.settlingLinks)).toEqual({});
    expect(await stores.backstop.getByKey(NEVER_STORED)).toBeUndefined();
  });

  it('a cleared link whose write failed keeps the tombstone, and no later session responds the request paid', async () => {
    const w = makeWorld();
    await linkedNeverStoredCancel(w);
    const responded: unknown[] = [];
    recordResponses(w, responded);
    w.kv.failWriteKeys.add(STORE_KEYS.settlingLinks);

    await w.facade.start();
    await w.facade.resumeNow();

    const stores = createMachineStores(w.kv);
    expect(await stores.backstop.getByKey(NEVER_STORED), 'the link is still on disk').toBeDefined();
    expect(w.kv.map.get(STORE_KEYS.settlingLinks)).toMatchObject({ r1: { transferId: NEVER_STORED } });

    await w.facade.stop();
    w.kv.failWriteKeys.delete(STORE_KEYS.settlingLinks);
    const restarted = makeWorld({ restartOf: w });
    recordResponses(restarted, responded);
    await restarted.facade.start();
    await restarted.facade.resumeNow();
    await restarted.facade.resumeNow();

    expect(responded, 'nothing moved: the request must never be responded paid').toEqual([]);
    expect(w.kv.map.get(STORE_KEYS.settlingLinks)).toEqual({});
    expect(await stores.backstop.getByKey(NEVER_STORED)).toBeUndefined();
  });
});
