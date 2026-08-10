// #737: a source pinned by an intent that is still converging is NOT spendable
// balance, and the refusal that follows says exactly that. The reporter (§5.2)
// and the selector (§5.4) must agree — a wallet that advertises money it will
// refuse to spend sends its owner auditing a treasury that was never short.

import { afterEach, describe, expect, it } from 'vitest';

import { ProofUnconfirmedError } from '../../../token-engine/errors';
import { IntentPins, type IntentPinsDeps } from '../../../modules/payments-v2/select/pins';
import { SpendQueue } from '../../../modules/payments-v2/select/queue';
import { ReservationLedger } from '../../../modules/payments-v2/select/ledger';
import { COIN, cleanupWorlds, flushTail, makeWorld, ownCaller, type World } from './facade-harness';

afterEach(cleanupWorlds);

/** Parks one send as an OPEN intent (certification inconclusive), as #737's gateway did. */
async function parkKeepOpen(world: World, amount: string): Promise<void> {
  world.engine.afterOp = (_key, kind) => (kind === 'direct' ? new ProofUnconfirmedError('proof fetch inconclusive') : null);
  await expect(
    world.facade.send({ recipient: '@peer', amount, coinId: COIN })
  ).rejects.toMatchObject({ code: 'CERTIFICATION_UNCONFIRMED' });
  await flushTail();
}

describe('#737 pinned tokens are not spendable balance', () => {
  it('a keep-open source is reported transferring, never confirmed — and the total tracks the pin', async () => {
    const world = makeWorld();
    const pinned = await world.seed(100n);
    await world.seed(60n);
    await world.facade.start();

    await parkKeepOpen(world, '100');

    const [asset] = await world.facade.assets(COIN);
    expect(asset.confirmedAmount).toBe('60');
    expect(asset.totalAmount).toBe('60');
    expect(asset.confirmedTokenCount).toBe(1);
    expect(asset.transferringAmount).toBe('100');
    expect(asset.transferringTokenCount).toBe(1);
    const shown = world.facade.tokens().find((t) => t.id === pinned.blob.tokenId);
    expect(shown?.status).toBe('transferring');
  });

  it('the refusal names the pin: same CODE, a message that counts the free, the pinned and the transfers', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.seed(60n);
    await world.facade.start();
    await parkKeepOpen(world, '100');

    // 100 is coverable ONLY by the pinned token — 60 is free, 100 is held.
    const err = await world.facade
      .send({ recipient: '@peer', amount: '100', coinId: COIN })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'SEND_INSUFFICIENT_BALANCE' });
    const message = (err as Error).message;
    expect(message).toContain('need 100');
    expect(message).toContain('60 free');
    expect(message).toContain('100 pinned by 1 transfer(s) still converging');
    expect(message).toContain('pendingTransfers()');
    expect(message).toContain('do not re-send');
  });

  it('nothing pinned: the plain wording is unchanged', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();

    const err = await world.facade
      .send({ recipient: '@peer', amount: '500', coinId: COIN })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: 'SEND_INSUFFICIENT_BALANCE',
      message: 'Insufficient balance for this transaction',
    });
  });

  it('an intent that stops being open stops pinning: the source is confirmed again and spends', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();
    // Dies before the source is ever touched, so this one provably never committed.
    world.engine.beforeOp = () => {
      throw new ProofUnconfirmedError('proof fetch inconclusive');
    };
    await expect(
      world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN })
    ).rejects.toMatchObject({ code: 'CERTIFICATION_UNCONFIRMED' });
    await flushTail();
    expect((await world.facade.assets(COIN))[0].confirmedAmount).toBe('0');

    const [intent] = await world.api.listIntents(ownCaller, 'open');
    await world.innerClient.abortIntent(intent.transferId);
    world.engine.beforeOp = null;
    await world.facade.resumeNow(); // the pass GCs the residue row — nothing is open now
    await flushTail();

    const [asset] = await world.facade.assets(COIN);
    expect(asset.confirmedAmount).toBe('100');
    expect(asset.transferringAmount).toBe('0');
    const ok = await world.facade.send({ recipient: '@peer', amount: '100', coinId: COIN });
    expect(ok.status).toBe('delivered');
  });

  it('across a RESTART the pin is re-derived from the open intent: still transferring, still refused', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();
    await parkKeepOpen(world, '100');
    await world.facade.stop();

    // Fresh facade, empty in-memory ledger, same server + durable stores. The
    // certification stays inconclusive, so the intent stays open.
    const restarted = makeWorld({ restartOf: world });
    await restarted.facade.start();
    await flushTail();

    const [asset] = await restarted.facade.assets(COIN);
    expect(asset.confirmedAmount).toBe('0');
    expect(asset.transferringAmount).toBe('100');
    const err = await restarted.facade
      .send({ recipient: '@peer', amount: '100', coinId: COIN })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SEND_INSUFFICIENT_BALANCE' });
    expect((err as Error).message).toContain('100 pinned by 1 transfer(s) still converging');
  });
});

describe('#738 review: the held-set gate fails CLOSED', () => {
  function makePins(openIntents: IntentPinsDeps['openIntents']): {
    pins: IntentPins;
    ledger: ReservationLedger;
  } {
    const ledger = new ReservationLedger();
    const pins = new IntentPins({
      ledger,
      openIntents,
      isActive: () => false,
      release: () => undefined,
      changed: () => undefined,
    });
    return { pins, ledger };
  }

  it('a fresh ledger is unproven: nothing plans and nothing reports free', () => {
    const ledger = new ReservationLedger();
    expect(ledger.unprovenReason()).not.toBeNull();
    const queue = new SpendQueue({ ledger, getPool: () => [{ tokenId: 't1', amount: 100n }] });
    expect(() => queue.plan('r1', { coinId: COIN, amount: '100' })).toThrow(
      /spending is paused/i
    );
  });

  it('a backstop read failure leaves the ledger unproven instead of re-offering held sources', async () => {
    const { pins, ledger } = makePins(async () => {
      throw new Error('IndexedDB unavailable');
    });
    await pins.sync().catch(() => undefined);
    // Never resolves into "no holder, therefore free".
    expect(ledger.unprovenReason()).not.toBeNull();
  });

  it('an undecodable OPEN intent keeps the ledger unproven rather than counting as zero sources', async () => {
    const { pins, ledger } = makePins(async () => ({ open: new Map(), complete: false }));
    await pins.sync();
    expect(ledger.unprovenReason()).not.toBeNull();
  });

  it('an unreadable open intent across a RESTART: the report and the refusal AGREE — nothing free, nothing spendable', async () => {
    const world = makeWorld();
    await world.seed(100n);
    await world.facade.start();
    await parkKeepOpen(world, '100');
    await world.facade.stop();

    // Corrupt the still-open intent's envelope so its sources cannot be
    // reconstructed. The pre-#738 bug read that as "holds nothing".
    const intentsKey = [...world.kv.map.keys()].find((k) => k.endsWith('intents'));
    expect(intentsKey).toBeDefined();
    const rows = world.kv.map.get(intentsKey!) as { payloadEnvelope: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) row.payloadEnvelope = 'not-decryptable';

    const restarted = makeWorld({ restartOf: world });
    await restarted.facade.start();
    await flushTail();

    // The REPORT must not call it confirmed...
    const [asset] = await restarted.facade.assets(COIN);
    expect(asset.confirmedAmount).toBe('0');
    // ...and the SPEND path must refuse. Disagreement between these two is the
    // #737 complaint; a permissive answer from EITHER is the #738 double-spend.
    const err = await restarted.facade
      .send({ recipient: '@peer', amount: '100', coinId: COIN })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'SEND_INSUFFICIENT_BALANCE' });
  });

  it('a pass that reconstructs every open intent makes the ledger authoritative', async () => {
    const { pins, ledger } = makePins(async () => ({ open: new Map(), complete: true }));
    await pins.sync();
    expect(ledger.unprovenReason()).toBeNull();
  });
});

describe('#738: the gate signals transitions, not passes', () => {
  it('a repeated complete sync emits once — the heartbeat must not spam inventory:updated', async () => {
    let emits = 0;
    const ledger = new ReservationLedger();
    const pins = new IntentPins({
      ledger,
      openIntents: async () => ({ open: new Map(), complete: true }),
      isActive: () => false,
      release: () => undefined,
      changed: () => {
        emits += 1;
      },
    });
    await pins.sync();
    await pins.sync();
    await pins.sync();
    expect(emits).toBe(1);
  });
});
