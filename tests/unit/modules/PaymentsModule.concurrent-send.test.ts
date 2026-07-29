/**
 * Two overlapping send() calls for the same coin, driven through PaymentsModule.
 * They must never plan against the same source token, and a send that cannot be
 * covered right now QUEUES on the other's change instead of failing.
 *
 * Nothing exercised this end-to-end before: SpendQueue and TokenReservationLedger
 * are unit-tested directly, and PaymentsModule.concurrency.test.ts does not import
 * PaymentsModule at all — so the module's own contention path, the one any
 * sendOnce refactor moves, had no coverage.
 *
 * Instrumented: the second send does enter the plan step while the first is
 * mid-flight, with the first send's source still in its pool.
 *
 * WHAT PINS IT (mutation-verified): the reservation gate in SpendPlanner.planSend
 * — building the free view from `ledger.getFreeAmount` rather than the raw token
 * amount. Relaxing that one filter turns all three red.
 *
 * WHAT DOES NOT (also mutation-verified, so no false comfort): the "SYNCHRONOUS
 * CRITICAL SECTION (no awaits)" property in sendOnce. Inserting `await
 * Promise.resolve()` — or a 50ms sleep — between the pendingChangeAmount scan and
 * planSend() keeps all three green, because atomicity is enforced inside
 * planSend's synchronous reserve, not by the absence of awaits around it. The
 * scan only decides queue-vs-hard-fail, and only matters once the source has left
 * the token map; these tests do not reach that window.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  makeFullPresetWallet,
  seedServerToken,
  startFakeWalletApi,
  type PresetWallet,
} from '../../support/preset-wallet';
import { testIdentity } from '../../support/wallet-api-test-helpers';
import type { FakeWalletApi } from '../../support/fake-wallet-api';
import type { TransportProvider } from '../../../transport';

const UCT = '11'.repeat(32);
const SELF = testIdentity(41);
const BOB = testIdentity(42);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Resolves BOB so send() gets a chain pubkey; assets never ride this rail. */
function resolvingTransport(): TransportProvider {
  return {
    resolve: vi.fn().mockResolvedValue({
      chainPubkey: BOB.chainPubkey,
      transportPubkey: 'bb'.repeat(32),
      directAddress: 'DIRECT://bob',
      nametag: 'bob',
    }),
    resolveNametagInfo: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    isConnected: () => true,
  } as unknown as TransportProvider;
}

async function wallet(): Promise<{ fake: FakeWalletApi; w: PresetWallet }> {
  const { fake, baseUrl, stop } = await startFakeWalletApi();
  cleanups.push(stop);
  const w = makeFullPresetWallet({
    baseUrl, network: fake.network, who: SELF, deviceId: 'concurrent-send',
    transport: resolvingTransport(),
  });
  cleanups.push(w.destroy);
  return { fake, w };
}

function heldTotal(w: PresetWallet): bigint {
  return w.module
    .getTokens()
    .filter((t) => t.status === 'confirmed')
    .reduce((sum, t) => sum + BigInt(t.amount), 0n);
}

describe('two concurrent send() calls contend for one balance', () => {
  it('covers both from separate sources without double-spending either', async () => {
    const { fake, w } = await wallet();
    await seedServerToken(fake, w, UCT, 100n);
    await seedServerToken(fake, w, UCT, 100n);
    await w.module.load();
    expect(heldTotal(w)).toBe(200n);

    // Fired without awaiting between them: the second reaches plan time while
    // the first is mid-flight and still holds its source.
    const [a, b] = await Promise.all([
      w.module.send({ recipient: BOB.chainPubkey, amount: '100', coinId: UCT }),
      w.module.send({ recipient: BOB.chainPubkey, amount: '100', coinId: UCT }),
    ]);

    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
    // Distinct sources — neither send planned against the token the other took.
    expect(a.id).not.toBe(b.id);
    const spent = [...a.tokenTransfers, ...b.tokenTransfers].map((t) => t.sourceTokenId);
    expect(new Set(spent).size).toBe(spent.length);

    // Value conserved: 200 in, 200 sent, nothing left and nothing conjured.
    expect(heldTotal(w)).toBe(0n);
  });

  it('a send that needs the other send\'s change QUEUES instead of failing', async () => {
    const { fake, w } = await wallet();
    // ONE source: the second send can only be covered by the first send's change.
    await seedServerToken(fake, w, UCT, 100n);
    await w.module.load();
    expect(heldTotal(w)).toBe(100n);

    const [a, b] = await Promise.all([
      w.module.send({ recipient: BOB.chainPubkey, amount: '60', coinId: UCT }),
      w.module.send({ recipient: BOB.chainPubkey, amount: '40', coinId: UCT }),
    ]);

    // The queued one must not have been rejected as SEND_INSUFFICIENT_BALANCE —
    // it waits for the change token rather than racing the ledger.
    expect(a.status).toBe('completed');
    expect(b.status).toBe('completed');
    expect(heldTotal(w)).toBe(0n);
  });

  it('over-committing the only token completes exactly one send', async () => {
    const { fake, w } = await wallet();
    await seedServerToken(fake, w, UCT, 100n);
    await w.module.load();

    const a = w.module.send({ recipient: BOB.chainPubkey, amount: '100', coinId: UCT });
    const b = w.module.send({ recipient: BOB.chainPubkey, amount: '100', coinId: UCT });
    const settledFirst = await Promise.race([a, b].map((p) => p.catch((e) => e)));
    expect((settledFirst as { status?: string }).status).toBe('completed');
    expect(heldTotal(w)).toBe(0n);

    // The loser does NOT fail fast: it parks in the SpendQueue for the full
    // QUEUE_TIMEOUT_MS waiting for change that the whole-token spend will never
    // produce. Tear the module down — destroy() rejects queued entries — rather
    // than idle 30s here. Either way it must never come back 'completed'.
    await w.module.destroy();
    const both = await Promise.allSettled([a, b]);
    const completed = both.filter((r) => r.status === 'fulfilled' && r.value.status === 'completed');
    expect(completed).toHaveLength(1);
  });
});
