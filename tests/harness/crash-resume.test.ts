/**
 * Phase-2 harness — the SIGKILL crash drill (AC-E5 over the REAL backend).
 *
 * A child-process wallet runner (support/send-runner.ts) performs a send and
 * is SIGKILLed at a DETERMINISTIC mid-send point: its wallet-api fetch hook
 * prints `HARNESS_KILL_POINT` and hangs forever on the FIRST
 * `POST /v1/inventory/apply` — by the §7/E.3 pipeline ordering that instant
 * is provably:
 *   - AFTER the intent was server-persisted (putIntent is awaited pre-engine),
 *   - AFTER the engine submitted and finished (certified at the stack's
 *     aggregator, whose state survives the child),
 *   - AFTER the mailbox deposit was server-acked,
 *   - BEFORE the apply/complete/history tail.
 * The parent fences on the marker (observable state, no sleeps), verifies the
 * server-side mid-send facts through a pump-less RAW client (a full wallet
 * would race: the real backend pushes §9 wakes), SIGKILLs, then starts a
 * FRESH process from the SAME seed (new device, empty local state) which
 * resumes via `resumeOpenIntents` — the S4 sign-in path.
 *
 * Asserted outcome: the finished token is recovered and delivered, no funds
 * lost, NO duplicate delivery (the re-run's idempotent re-deposit lands on the
 * same content-derived entry — §6), exactly one dedupKey'd SENT history row,
 * and the intent closes — the E.2/E.3/AC-E5 property over the real backend
 * and the real duplicate-submit wire contract.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { createHarnessWallet, createRawClient, type HarnessWallet } from './support/harness-wallet';
import { HARNESS_COIN, randomIdentity, stackFromEnv } from './support/stack';
import { KILL_POINT_MARKER, RESUME_RESULT_MARKER } from './support/runner-protocol';
import { spawnRunner } from './support/spawn-runner';
import type { CoinBalance } from '../../wallet-api';

const stack = stackFromEnv();

const wallets: HarnessWallet[] = [];
afterEach(() => {
  while (wallets.length) wallets.pop()?.destroy();
});

function totalOf(balances: CoinBalance[]): bigint {
  return balances.find((b) => b.coinId === HARNESS_COIN)?.total ?? 0n;
}

describe('SIGKILL mid-send → fresh-process resume (AC-E5)', () => {
  it('recovers the finished token, delivers exactly once, loses nothing', async () => {
    const aId = randomIdentity();
    const bId = randomIdentity();

    // Fund wallet A (full preset — mint lands in the server inventory).
    const a = await createHarnessWallet({ stack, identity: aId, deviceId: 'crash-a-parent', custody: 'inventory' });
    wallets.push(a);
    await a.module.load();
    expect((await a.module.mintFungibleToken(HARNESS_COIN, 1000n)).success).toBe(true);
    expect(totalOf(await a.client.getBalances())).toBe(1000n);
    a.destroy(); // no background pumps may touch A while the drill runs
    wallets.pop();

    // Pump-less raw clients for every wire assertion (deterministic reads).
    const aClient = createRawClient(stack, aId, 'crash-a-raw');
    const bClient = createRawClient(stack, bId, 'crash-b-raw');

    const runnerEnv = {
      HARNESS_PRIVKEY: aId.privateKey,
      HARNESS_PUBKEY: aId.chainPubkey,
      HARNESS_RECIPIENT: bId.chainPubkey,
      HARNESS_AMOUNT: '1000',
    };

    // Phase 1: the child reaches the kill point (deterministic marker).
    const sender = spawnRunner('send', runnerEnv);
    await sender.waitForLine(KILL_POINT_MARKER);

    // Mid-send server facts, observed BEFORE the kill: open intent persisted,
    // deposit landed (unclaimed), source still active (apply never ran).
    const openIntents = await aClient.listIntents('open');
    expect(openIntents).toHaveLength(1);
    const transferId = openIntents[0].transferId;
    const before = (await bClient.listMailbox()).entries.filter((e) => e.transferId === transferId);
    expect(before).toHaveLength(1);
    expect(before[0].status).toBe('unclaimed');
    expect(totalOf(await aClient.getBalances())).toBe(1000n);

    await sender.kill(); // SIGKILL — the apply/complete tail never happens

    // ADVANCE THE AGGREGATOR TREE between kill and resume (live reality: other
    // users' certifications always land in between). The aggregator recomputes
    // inclusion proofs per request (st-sdk#126), so the resume's re-fetched
    // proof — and the rebuilt token blob's content-addressed key — differ from
    // the originally-deposited blob's. The re-deposit then 409s under §6, and
    // the S7 deliver contract must absorb it as idempotent success (found by
    // the S5 live e2e, 2026-06-12; without the absorption this drill fails
    // exactly like the live one did).
    const treeAdvancer = await createHarnessWallet({
      stack,
      identity: randomIdentity(),
      deviceId: 'crash-tree-advance',
      custody: 'inventory',
    });
    wallets.push(treeAdvancer);
    await treeAdvancer.module.load();
    expect((await treeAdvancer.module.mintFungibleToken(HARNESS_COIN, 1n)).success).toBe(true);
    treeAdvancer.destroy();
    wallets.pop();

    // Phase 2: a FRESH process from the same seed resumes open intents.
    const resumer = spawnRunner('resume', runnerEnv);
    const resultLine = await resumer.waitForLine(RESUME_RESULT_MARKER);
    await resumer.waitForExit();
    const outcome = JSON.parse(resultLine.slice(RESUME_RESULT_MARKER.length + 1)) as {
      resumed: string[];
      conflicted: string[];
      failed: string[];
    };
    expect(outcome).toEqual({ resumed: [transferId], conflicted: [], failed: [] });

    // The intent closed; the spend is recorded (§5.3 evidenced by the deposit).
    expect(await aClient.listIntents('open')).toHaveLength(0);

    // No duplicate delivery: the resume's idempotent re-deposit landed on the
    // SAME content-derived entry — still exactly one mailbox entry (§6).
    const afterResume = (await bClient.listMailbox()).entries.filter((e) => e.transferId === transferId);
    expect(afterResume).toHaveLength(1);
    expect(afterResume[0].status).toBe('unclaimed'); // B has not claimed yet

    // B comes online (fresh full wallet) and claims EXACTLY one delivery.
    const b = await createHarnessWallet({ stack, identity: bId, deviceId: 'crash-b', custody: 'inventory' });
    wallets.push(b);
    await b.module.load();
    const { transfers } = await b.module.receive();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].tokens[0].amount).toBe('1000');

    const claimed = (await bClient.listMailbox()).entries.filter((e) => e.transferId === transferId);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].status).toBe('claimed');

    // No funds lost; both sides converge through the real backend.
    expect(totalOf(await aClient.getBalances())).toBe(0n);
    expect(totalOf(await bClient.getBalances())).toBe(1000n);

    // Exactly ONE dedupKey'd SENT row under the original transferId (§10).
    const history = await aClient.listHistory();
    expect(history.records.filter((r) => r.dedupKey === `SENT_transfer_${transferId}`)).toHaveLength(1);

    // Re-discovery is a no-op: the entry is resolved and seen.
    const again = await b.module.receive();
    expect(again.transfers).toHaveLength(0);
  });
});
