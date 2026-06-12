/**
 * S5 live e2e — the SIGKILL crash drill on the REAL testnet2 aggregator
 * (AC-E5: fresh-DEVICE resume; sdk-changes E.2/E.3 over the real gateway).
 *
 * Same deterministic drill as the phase-2 harness (tests/harness/
 * crash-resume.test.ts), with every aggregator interaction REAL: the child
 * wallet runner is SIGKILLed at the first `POST /v1/inventory/apply` — by the
 * §7/E.3 pipeline ordering that is provably AFTER the intent was
 * server-persisted, AFTER the transfer CERTIFIED on the real testnet2 chain,
 * and AFTER the mailbox deposit was acked, but BEFORE the apply/complete tail.
 * A fresh process from the SAME seed on a DIFFERENT deviceId (new device,
 * empty local state — the AC-E5 posture) resumes via `resumeOpenIntents`:
 * deterministic realization rebuilds the byte-identical transaction, the
 * duplicate submit hits the real gateway (observed 2026-06-12, recorded in
 * wallet-api sdk-changes E.2: first-write-wins `SUCCESS` — no
 * STATE_ID_EXISTS), the proof is re-fetched, MATCH-VERIFIED and applied —
 * no funds lost, delivered exactly once.
 *
 * Deliberately a WHOLE-TOKEN send: split full-rerun-after-certified-mints
 * remains the #501 known gap (burn-certified resume only) — this drill does
 * not touch that path and must not be extended to until #501 is decided.
 */

import { describe, it, expect, afterEach } from 'vitest';

import { createHarnessWallet, createRawClient, type HarnessWallet } from '../support/harness-wallet';
import { HARNESS_COIN, randomIdentity } from '../support/stack';
import { KILL_POINT_MARKER, RESUME_RESULT_MARKER } from '../support/runner-protocol';
import { spawnRunner } from '../support/spawn-runner';
import { liveStackFromEnv } from './support/live-stack';
import type { CoinBalance } from '../../../wallet-api';

const stack = liveStackFromEnv();

const wallets: HarnessWallet[] = [];
afterEach(() => {
  while (wallets.length) wallets.pop()?.destroy();
});

function totalOf(balances: CoinBalance[]): bigint {
  return balances.find((b) => b.coinId === HARNESS_COIN)?.total ?? 0n;
}

describe('S5/AC-E5 — SIGKILL after REAL certification → fresh-device resume', () => {
  it('recovers the certified transfer on a new device, delivers exactly once, loses nothing', async () => {
    const aId = randomIdentity();
    const bId = randomIdentity();

    // Fund wallet A with a REAL testnet2 mint (full preset → server inventory).
    const a = await createHarnessWallet({ stack, identity: aId, deviceId: 'live-crash-a-parent', custody: 'inventory' });
    wallets.push(a);
    await a.module.load();
    expect((await a.module.mintFungibleToken(HARNESS_COIN, 1000n)).success).toBe(true);
    expect(totalOf(await a.client.getBalances())).toBe(1000n);
    a.destroy(); // no background pumps may touch A while the drill runs
    wallets.pop();

    // Pump-less raw clients for every wire assertion (deterministic reads).
    const aClient = createRawClient(stack, aId, 'live-crash-a-raw');
    const bClient = createRawClient(stack, bId, 'live-crash-b-raw');

    const runnerEnv = {
      HARNESS_PRIVKEY: aId.privateKey,
      HARNESS_PUBKEY: aId.chainPubkey,
      HARNESS_RECIPIENT: bId.chainPubkey,
      HARNESS_AMOUNT: '1000', // whole token — the split-rerun path stays out (#501)
    };

    // Phase 1: the child certifies the transfer ON THE REAL CHAIN and reaches
    // the deterministic kill point (the first inventory apply).
    const sender = spawnRunner('send', runnerEnv);
    await sender.waitForLine(KILL_POINT_MARKER, 240_000); // real certification budget
    // Mid-send server facts, observed BEFORE the kill: open intent persisted
    // (E.3), deposit landed (unclaimed), source still active (no apply ran).
    const openIntents = await aClient.listIntents('open');
    expect(openIntents).toHaveLength(1);
    const transferId = openIntents[0].transferId;
    const before = (await bClient.listMailbox()).entries.filter((e) => e.transferId === transferId);
    expect(before).toHaveLength(1);
    expect(before[0].status).toBe('unclaimed');
    expect(totalOf(await aClient.getBalances())).toBe(1000n);

    await sender.kill(); // SIGKILL — the apply/complete tail never happens

    // Phase 2: a FRESH process, SAME seed, DIFFERENT deviceId (AC-E5's
    // fresh-device posture) resumes open intents through the REAL gateway:
    // byte-identical rebuild → duplicate submit (SUCCESS, first-write-wins) →
    // proof re-fetch → match-verify OK → apply.
    const resumer = spawnRunner('resume', runnerEnv);
    const resultLine = await resumer.waitForLine(RESUME_RESULT_MARKER, 240_000);
    await resumer.waitForExit();
    const outcome = JSON.parse(resultLine.slice(RESUME_RESULT_MARKER.length + 1)) as {
      resumed: string[];
      conflicted: string[];
      failed: string[];
    };
    expect(outcome).toEqual({ resumed: [transferId], conflicted: [], failed: [] });

    // The intent closed; no duplicate delivery (the idempotent re-deposit
    // landed on the same content-derived entry — §6).
    expect(await aClient.listIntents('open')).toHaveLength(0);
    const afterResume = (await bClient.listMailbox()).entries.filter((e) => e.transferId === transferId);
    expect(afterResume).toHaveLength(1);
    expect(afterResume[0].status).toBe('unclaimed');

    // B claims exactly one delivery; its wallet verifies the REAL proof chain.
    const b = await createHarnessWallet({ stack, identity: bId, deviceId: 'live-crash-b', custody: 'inventory' });
    wallets.push(b);
    await b.module.load();
    const { transfers } = await b.module.receive();
    expect(transfers).toHaveLength(1);
    expect(transfers[0].tokens[0]).toMatchObject({ amount: '1000', status: 'confirmed' });

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
