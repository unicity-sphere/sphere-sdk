// §5.9 of docs/PAYMENTS-V2-DESIGN.md: SENT history records what SETTLED, never the plan — the
// value of the certified recipient blobs (summarize()'s committed set). A journal-rehydrated
// resume leg has no source token, but every committed leg carries its recipient blob.

import type { ITokenEngine } from '../../../token-engine/engine';
import { coinIdOf } from './payload-view';
import type { MachineDeps } from './TransferMachine';
import type { IntentPayload, OpOutcome } from './types';

export interface SettledAttempt {
  transferId: string;
  payload: IntentPayload;
  phase: 'sent' | 'resumed';
  committed: OpOutcome[];
}

/** SENT history, whatever the apply or the close answered (the server dedupKey is the transferId). Never throws. */
export async function recordSettled(
  engine: ITokenEngine,
  recordHistory: MachineDeps['recordHistory'],
  { transferId, payload, phase, committed }: SettledAttempt
): Promise<void> {
  try {
    // A token-addressed spend has no coin to sum: what settled is the token itself.
    const coinId = coinIdOf(payload);
    const committedAmount =
      coinId === undefined ? '0' : await settledAmount(engine, coinId, committed);
    // A whole-token spend records what the moved token ACTUALLY carried, never `assets: []`.
    const committedAssets =
      coinId === undefined ? await settledAssets(engine, committed) : undefined;
    await recordHistory?.({
      transferId,
      payload,
      phase,
      committedAmount,
      ...(committedAssets !== undefined ? { committedAssets } : {}),
    });
  } catch {
    /* #842: load-bearing — a rejection would override the apply's outcome, or go unhandled in run() */
  }
}

/** Every asset across the certified recipient blobs — the whole-spend twin of settledAmount. */
async function settledAssets(
  engine: ITokenEngine,
  committed: OpOutcome[]
): Promise<{ coinId: string; amount: string }[]> {
  const total = new Map<string, bigint>();
  for (const outcome of committed) {
    if (outcome.recipientBlob === undefined) continue;
    const token = await engine.decodeToken({ tokenId: '', token: outcome.recipientBlob });
    for (const asset of engine.readValue(token)?.assets ?? []) {
      total.set(asset.coinId, (total.get(asset.coinId) ?? 0n) + asset.amount);
    }
  }
  return [...total].map(([coinId, amount]) => ({ coinId, amount: amount.toString() }));
}

async function settledAmount(engine: ITokenEngine, coinId: string, committed: OpOutcome[]): Promise<string> {
  let total = 0n;
  for (const outcome of committed) {
    if (outcome.recipientBlob === undefined) continue;
    const token = await engine.decodeToken({ tokenId: '', token: outcome.recipientBlob });
    total += engine.balanceOf(token, coinId);
  }
  return total.toString();
}
