/**
 * tests/harness/support/send-runner.ts — the crash-drill child-process wallet
 * runner (spawned via `node --import tsx`; never imported by vitest).
 *
 * Phases (argv[2]):
 *
 * - `send` — compose the FULL S4 preset wallet from the seed key, `load()`,
 *   then `send()`. The injected wallet-api fetch hook makes the kill point
 *   DETERMINISTIC: the FIRST `POST /v1/inventory/apply` prints the
 *   `HARNESS_KILL_POINT` marker and never resolves (the request is never
 *   forwarded). At that instant, by the send pipeline's own ordering (§7/E.3):
 *   the intent is server-persisted (awaited putIntent), the engine submitted
 *   and finished the transfer (certified on-chain at the mock aggregator,
 *   which lives in the compose stack and survives this process), and the
 *   mailbox deposit was server-acked — while the apply/complete/history tail
 *   never happened. The parent SIGKILLs on the marker — no sleeps, no races.
 *
 * - `resume` — a FRESH process from the SAME seed (new device, empty local
 *   state: the AC-E5 fresh-device posture): `load()`, then
 *   `resumeOpenIntents()` (the S4 sign-in resume), printing the outcome as
 *   the `HARNESS_RESUME_RESULT {...}` marker line.
 *
 * Markers are single stdout lines — the parent fences on them (observable
 * state, §18 determinism rule).
 */

import { HARNESS_COIN, stackFromEnv } from './stack';
import { createHarnessWallet } from './harness-wallet';
import { KILL_POINT_MARKER, LOADED_MARKER, RESUME_RESULT_MARKER } from './runner-protocol';
import type { FetchLike } from '../../../wallet-api';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`send-runner: missing env ${name}`);
  return value;
}

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Forwards everything except the first inventory apply, which hangs forever. */
function killPointFetch(): FetchLike {
  let intercepted = false;
  return (url, init) => {
    if (!intercepted && init?.method === 'POST' && url.endsWith('/v1/inventory/apply')) {
      intercepted = true;
      emit(KILL_POINT_MARKER);
      // Never resolves and never reaches the wire: the parent SIGKILLs here.
      return new Promise(() => {});
    }
    return fetch(url, init as RequestInit);
  };
}

async function main(): Promise<void> {
  const phase = process.argv[2];
  const stack = stackFromEnv();
  const privateKey = requireEnv('HARNESS_PRIVKEY');
  const chainPubkey = requireEnv('HARNESS_PUBKEY');

  if (phase === 'send') {
    const wallet = await createHarnessWallet({
      stack,
      identity: { privateKey, chainPubkey },
      deviceId: 'crash-drill-send',
      custody: 'inventory',
      fetchFn: killPointFetch(),
    });
    await wallet.module.load();
    emit(LOADED_MARKER);
    // Hangs at the kill point by construction; the promise never settles.
    await wallet.module.send({
      recipient: requireEnv('HARNESS_RECIPIENT'),
      amount: requireEnv('HARNESS_AMOUNT'),
      coinId: HARNESS_COIN,
    });
    throw new Error('send-runner: send() returned — the kill point never engaged');
  }

  if (phase === 'resume') {
    const wallet = await createHarnessWallet({
      stack,
      identity: { privateKey, chainPubkey },
      deviceId: 'crash-drill-resume',
      custody: 'inventory',
    });
    await wallet.module.load();
    const outcome = await wallet.module.resumeOpenIntents();
    emit(`${RESUME_RESULT_MARKER} ${JSON.stringify(outcome)}`);
    wallet.destroy();
    process.exit(0);
  }

  throw new Error(`send-runner: unknown phase "${phase ?? ''}"`);
}

// Run only when spawned as the entrypoint (spawn-runner.ts) — never on import.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error: unknown) => {
    console.error('send-runner failed:', error);
    process.exit(1);
  });
}
