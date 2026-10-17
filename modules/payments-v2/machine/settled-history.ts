// §5.9 of docs/PAYMENTS-V2-DESIGN.md: SENT history records what SETTLED, never the plan — the
// value of the certified recipient blobs (summarize()'s committed set). A journal-rehydrated
// resume leg has no source token, but every committed leg carries its recipient blob.

import type { ITokenEngine } from '../../../token-engine/engine';
import type { SentOutboxEntry } from '../stores';
import type { MachineStores } from './journal';
import { coinIdOf } from './payload-view';
import type { MachineDeps } from './TransferMachine';
import type { IntentPayload, OpOutcome } from './types';

export interface SettledAttempt {
  transferId: string;
  payload: IntentPayload;
  phase: 'sent' | 'resumed';
  committed: OpOutcome[];
}

export type SettledRecord = Parameters<NonNullable<MachineDeps['recordHistory']>>[0];

/** #842: read locally, so it is awaited before the apply and the POST leaves first. Never throws. */
export async function settledRecord(
  engine: ITokenEngine,
  { transferId, payload, phase, committed }: SettledAttempt
): Promise<SettledRecord | undefined> {
  try {
    // A token-addressed spend has no coin to sum: what settled is the token itself.
    const coinId = coinIdOf(payload);
    const committedAmount =
      coinId === undefined ? '0' : await settledAmount(engine, coinId, committed);
    // A whole-token spend records what the moved token ACTUALLY carried, never `assets: []`.
    const committedAssets =
      coinId === undefined ? await settledAssets(engine, committed) : undefined;
    return { transferId, payload, phase, committedAmount, ...(committedAssets !== undefined ? { committedAssets } : {}) };
  } catch {
    return undefined; // a history failure never fails the money path
  }
}

/** Issues the POST at once (dedupKey = transferId); never rejects. `false`: a retry may still record it. */
export async function postSettled(recordHistory: MachineDeps['recordHistory'], record: SettledRecord | undefined): Promise<boolean> {
  if (record === undefined || recordHistory === undefined) return true;
  try {
    return (await recordHistory(record)) !== false;
  } catch {
    return false;
  }
}

export interface OutboxDeps {
  recordHistory: MachineDeps['recordHistory'];
  encryptPayload: MachineDeps['encryptPayload'];
  now: MachineDeps['now'];
  armHeartbeat: MachineDeps['armHeartbeat'];
  whileLive: MachineDeps['whileLive'];
  outbox: MachineStores['sentOutbox'];
}

/** #842: kept in the outbox BEFORE the apply (an applied row is never listed again); the POST is never awaited. */
export async function keepAndPost(deps: OutboxDeps, settled: SettledRecord | undefined): Promise<void> {
  if (settled === undefined || deps.recordHistory === undefined) return;
  const kept = await deps.outbox.getByKey(settled.transferId).catch(() => undefined);
  // The row's time on every attempt: the FIRST keep's, so a later resume or re-post moves nothing.
  const record = { ...settled, timestamp: kept?.createdAt ?? deps.now() };
  try {
    await deps.outbox.upsert(toOutbox(record, await deps.encryptPayload(record.payload)));
  } catch {
    /* the in-flight POST is then the record's only copy */
  }
  void postSettled(deps.recordHistory, record).then((done) => {
    if (done) whileLive(deps.whileLive, () => deps.outbox.removeByKey(record.transferId));
    else deps.armHeartbeat?.(); // kept: an idle wallet must still run the pass that re-posts it
  });
}

/** A detached outbox write runs only while its owner does; a stopped one leaves the entry to the next. */
function whileLive(fence: MachineDeps['whileLive'], write: () => Promise<unknown>): void {
  const guarded = (): Promise<unknown> => write().catch(() => undefined);
  if (fence === undefined) void guarded();
  else fence(guarded);
}

export interface RepostDeps {
  recordHistory: NonNullable<MachineDeps['recordHistory']>;
  whileLive: MachineDeps['whileLive'];
  outbox: MachineStores['sentOutbox'];
  readPayload(envelope: string): Promise<IntentPayload>;
}

/** #842: re-posts one kept record; it leaves once answered for good, or when no retry could post it. */
export async function repostKept(deps: RepostDeps, entry: SentOutboxEntry): Promise<void> {
  let record: SettledRecord | undefined;
  try {
    const { transferId, phase, committedAmount, committedAssets, createdAt: timestamp } = entry;
    const payload = await deps.readPayload(entry.payloadEnvelope);
    record = { transferId, payload, phase, committedAmount, timestamp, ...(committedAssets !== undefined ? { committedAssets } : {}) };
  } catch {
    record = undefined; // an unreadable payload never becomes readable
  }
  if (record === undefined || (await postSettled(deps.recordHistory, record))) {
    whileLive(deps.whileLive, () => deps.outbox.removeIfUnchanged(entry.transferId, entry));
  }
}

function toOutbox(record: SettledRecord & { timestamp: number }, payloadEnvelope: string): SentOutboxEntry {
  const { transferId, phase, committedAmount, committedAssets, timestamp } = record;
  return {
    transferId,
    payloadEnvelope,
    phase,
    committedAmount,
    ...(committedAssets !== undefined ? { committedAssets: committedAssets.map((asset) => ({ ...asset })) } : {}),
    createdAt: timestamp,
  };
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
