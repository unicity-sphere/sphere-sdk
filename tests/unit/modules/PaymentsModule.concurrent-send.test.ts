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
 * THE OVERLAP IS ASSERTED, NOT ASSUMED. A gated engine holds the first send
 * mid-transfer; the second must reach the module WHILE it is held. Firing both
 * promises and awaiting them proves nothing on its own — if a change serialized
 * send(), the first would simply finish before the second planned and every
 * assertion below would still hold. With the gate, serializing send() DEADLOCKS
 * these tests instead of silently hollowing them out.
 *
 * WHAT PINS IT (mutation-verified): the reservation gate in SpendPlanner.planSend
 * — building the free view from `ledger.getFreeAmount` rather than the raw token
 * amount. Relaxing that one filter turns these red.
 *
 * WHAT DOES NOT (also mutation-verified, so no false comfort): the "SYNCHRONOUS
 * CRITICAL SECTION (no awaits)" property in sendOnce. Inserting `await
 * Promise.resolve()` — or a 50ms sleep — between the pendingChangeAmount scan and
 * planSend() keeps them green, because atomicity is enforced inside planSend's
 * synchronous reserve, not by the absence of awaits around it. The scan only
 * decides queue-vs-hard-fail, and only matters once the source has left the token
 * map; these tests do not reach that window.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

import {
  makeFullPresetWallet,
  seedServerToken,
  startFakeWalletApi,
  type PresetWallet,
} from '../../support/preset-wallet';
import { testIdentity } from '../../support/wallet-api-test-helpers';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import type { FakeWalletApi } from '../../support/fake-wallet-api';
import type { TransportProvider } from '../../../transport';
import type {
  EngineOpOptions,
  SphereToken,
  SplitParams,
  SplitResult,
  TransferParams,
} from '../../../token-engine';

const UCT = '11'.repeat(32);
const SELF = testIdentity(41);
const BOB = testIdentity(42);

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/**
 * A FakeTokenEngine whose spends park at the gate, so a test can hold send A
 * mid-flight and observe what send B does meanwhile. Mints are NOT gated —
 * seeding must not deadlock.
 */
class GatedFakeTokenEngine extends FakeTokenEngine {
  /** tokenIds currently parked at the gate — one per in-flight spend. */
  readonly inFlight: string[] = [];
  private open = false;
  private readonly waiters: Array<() => void> = [];
  private readonly arrivals: Array<() => void> = [];

  /** Resolves once `count` spends are parked; rejects rather than hanging forever. */
  async waitForInFlight(count: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.length < count) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Only ${this.inFlight.length} of ${count} spends reached the engine — the sends did not overlap`
        );
      }
      await new Promise<void>((resolve) => {
        this.arrivals.push(resolve);
        setTimeout(resolve, 25);
      });
    }
  }

  /** Let every parked spend — and every later one — through. */
  release(): void {
    this.open = true;
    while (this.waiters.length) this.waiters.pop()!();
  }

  private async gate(token: SphereToken): Promise<void> {
    this.inFlight.push(this.tokenId(token));
    while (this.arrivals.length) this.arrivals.pop()!();
    if (this.open) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  public override async transfer(params: TransferParams, options?: EngineOpOptions): Promise<SphereToken> {
    await this.gate(params.token);
    return super.transfer(params, options);
  }

  public override async split(params: SplitParams, options?: EngineOpOptions): Promise<SplitResult> {
    await this.gate(params.token);
    return super.split(params, options);
  }
}

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

async function wallet(): Promise<{ fake: FakeWalletApi; w: PresetWallet; engine: GatedFakeTokenEngine }> {
  const { fake, baseUrl, stop } = await startFakeWalletApi();
  cleanups.push(stop);
  const w = makeFullPresetWallet({
    baseUrl,
    network: fake.network,
    who: SELF,
    deviceId: 'concurrent-send',
    transport: resolvingTransport(),
    engine: (config) => new GatedFakeTokenEngine(config),
  });
  cleanups.push(w.destroy);
  return { fake, w, engine: w.engine as GatedFakeTokenEngine };
}

function heldTotal(w: PresetWallet): bigint {
  return w.module
    .getTokens()
    .filter((t) => t.status === 'confirmed')
    .reduce((sum, t) => sum + BigInt(t.amount), 0n);
}

describe('two concurrent send() calls contend for one balance', () => {
  it('both plan while the other is mid-flight, against separate sources', async () => {
    const { fake, w, engine } = await wallet();
    await seedServerToken(fake, w, UCT, 100n);
    await seedServerToken(fake, w, UCT, 100n);
    await w.module.load();
    expect(heldTotal(w)).toBe(200n);

    const a = w.module.send({ recipient: BOB.chainPubkey, amount: '100', coinId: UCT });
    const b = w.module.send({ recipient: BOB.chainPubkey, amount: '100', coinId: UCT });

    // THE contention assertion: the second send planned and reached the engine
    // while the first was still parked there. Serialize send() and this throws.
    await engine.waitForInFlight(2);
    // Planned against different tokens — neither took the other's source.
    expect(new Set(engine.inFlight).size).toBe(2);

    engine.release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe('completed');
    expect(rb.status).toBe('completed');
    const spent = [...ra.tokenTransfers, ...rb.tokenTransfers].map((t) => t.sourceTokenId);
    expect(new Set(spent).size).toBe(spent.length);

    // Value conserved: 200 in, 200 sent, nothing left and nothing conjured.
    expect(heldTotal(w)).toBe(0n);
  });

  it("a send that needs the other send's change QUEUES instead of failing", async () => {
    const { fake, w, engine } = await wallet();
    // ONE source: the second send can only be covered by the first send's change.
    await seedServerToken(fake, w, UCT, 100n);
    await w.module.load();
    expect(heldTotal(w)).toBe(100n);

    const a = w.module.send({ recipient: BOB.chainPubkey, amount: '60', coinId: UCT });
    const b = w.module.send({ recipient: BOB.chainPubkey, amount: '40', coinId: UCT });

    // The split parks at the gate; the second send has nothing free to plan
    // against, so it must be waiting in the queue rather than at the engine.
    await engine.waitForInFlight(1);
    expect(engine.inFlight).toHaveLength(1);

    engine.release();
    const [ra, rb] = await Promise.all([a, b]);
    // Not rejected as SEND_INSUFFICIENT_BALANCE — it waited for the change token.
    expect(ra.status).toBe('completed');
    expect(rb.status).toBe('completed');
    expect(heldTotal(w)).toBe(0n);
  });

  it('over-committing the only token parks the loser in the queue, never completes it', async () => {
    const { fake, w, engine } = await wallet();
    await seedServerToken(fake, w, UCT, 100n);
    await w.module.load();

    const a = w.module.send({ recipient: BOB.chainPubkey, amount: '100', coinId: UCT });
    const b = w.module.send({ recipient: BOB.chainPubkey, amount: '100', coinId: UCT });
    await engine.waitForInFlight(1);
    engine.release();

    expect((await a).status).toBe('completed');
    expect(heldTotal(w)).toBe(0n);

    // The loser does NOT fail fast: it parks in the SpendQueue for the full
    // QUEUE_TIMEOUT_MS waiting for change that a whole-token spend never
    // produces. Tearing the module down rejects queued entries — which is also
    // the witness that it WAS queued: a send that planned after the winner
    // finished would have hard-failed SEND_INSUFFICIENT_BALANCE instead.
    await w.module.destroy();
    await expect(b).rejects.toMatchObject({ code: 'MODULE_DESTROYED' });
  });
});
