// §5.5 P6 — resume = the SAME TransferMachine, rehydrated from server-open
// intents: the #676 local-disposition gate, v:2 payload validation, batched
// cross-intent source reads, and {resumed, conflicted, failed} classification.

import { SphereError } from '../../../core/errors';
import { TOKEN_BLOB_VERSION } from '../../../token-engine/token-blob';
import type { SphereToken } from '../../../token-engine/types';
import type { DeliveryJournalEntry, IntentBackstopEntry } from '../stores';
import type { IntentPayload } from './types';
import { ATTENTION_CHECKPOINT_STUCK, createMachineStores, type MachineStores } from './journal';
import { TransferMachine, buildOps, classifyError, type MachineDeps } from './TransferMachine';

export interface ResumeReport {
  resumed: string[];
  conflicted: string[];
  failed: string[];
}

interface ResumeJob {
  transferId: string;
  payload: IntentPayload;
  journaled: Map<number, DeliveryJournalEntry>;
}

export async function resumeAll(deps: MachineDeps): Promise<ResumeReport> {
  const report: ResumeReport = { resumed: [], conflicted: [], failed: [] };
  const stores = createMachineStores(deps.kv);
  const open = await deps.intents.listOpen();

  let locals: Map<string, IntentBackstopEntry>;
  try {
    locals = new Map((await stores.backstop.list()).map((e) => [e.transferId, e]));
  } catch {
    // #676: local dispositions unknowable — a server-open intent could be
    // locally aborted, so resuming ANY would risk re-executing one. Defer all.
    return report;
  }
  await dropStaleLocalAborts(stores, locals, new Set(open.map((i) => i.transferId)));

  const jobs = await gateAndDecode(deps, stores, open, locals, report);
  const ctx: RunCtx = {
    deps,
    stores,
    machine: new TransferMachine(deps),
    sources: await fetchSources(deps, jobs),
  };
  for (const job of jobs) {
    await runOne(ctx, job, report);
  }
  return report;
}

interface RunCtx {
  deps: MachineDeps;
  stores: MachineStores;
  machine: TransferMachine;
  sources: Map<string, SphereToken>;
}

async function dropStaleLocalAborts(
  stores: MachineStores,
  locals: Map<string, IntentBackstopEntry>,
  openIds: Set<string>
): Promise<void> {
  for (const entry of locals.values()) {
    if (entry.disposition !== 'open' && !openIds.has(entry.transferId)) {
      await stores.backstop.drop(entry.transferId);
    }
  }
}

async function gateAndDecode(
  deps: MachineDeps,
  stores: MachineStores,
  open: { transferId: string; payload: string }[],
  locals: Map<string, IntentBackstopEntry>,
  report: ResumeReport
): Promise<ResumeJob[]> {
  const jobs: ResumeJob[] = [];
  for (const intent of open) {
    const local = locals.get(intent.transferId);
    if (local !== undefined && local.disposition !== 'open') {
      // #676: a locally-aborted intent is NEVER resumed — converge the server.
      try {
        await deps.intents.abort(intent.transferId);
        await stores.backstop.drop(intent.transferId);
      } catch {
        /* stays locally aborted; converged at the next resume */
      }
      report.conflicted.push(intent.transferId);
      continue;
    }
    let payload: IntentPayload;
    try {
      payload = validatePayload(await deps.decryptPayload(intent.payload));
    } catch {
      report.failed.push(intent.transferId);
      continue;
    }
    jobs.push({
      transferId: intent.transferId,
      payload,
      journaled: await stores.deliveryJournal.byTransfer(intent.transferId),
    });
  }
  return jobs;
}

/** One batched blob read across every intent (§7 start() posture). */
async function fetchSources(deps: MachineDeps, jobs: ResumeJob[]): Promise<Map<string, SphereToken>> {
  const needed = new Set<string>();
  for (const job of jobs) {
    for (const op of buildOps(job.payload)) {
      if (op.kind === 'direct' && job.journaled.has(op.opIndex)) continue;
      needed.add(op.sourceTokenId);
    }
  }
  const decoded = new Map<string, SphereToken>();
  if (needed.size === 0) return decoded;
  let blobs: Map<string, Uint8Array>;
  try {
    blobs = await deps.storage.getBlobs([...needed]);
  } catch {
    return decoded; // jobs that needed a source fail closed below
  }
  const engine = deps.engine();
  for (const [tokenId, bytes] of blobs) {
    try {
      decoded.set(tokenId, await engine.decodeToken({ v: TOKEN_BLOB_VERSION, network: 0, tokenId, token: bytes }));
    } catch {
      /* undecodable source: the needing job fails closed below */
    }
  }
  return decoded;
}

async function runOne(ctx: RunCtx, job: ResumeJob, report: ResumeReport): Promise<void> {
  const mine = new Map<string, SphereToken>();
  for (const op of buildOps(job.payload)) {
    if (op.kind === 'direct' && job.journaled.has(op.opIndex)) continue;
    const token = ctx.sources.get(op.sourceTokenId);
    if (token === undefined) {
      report.failed.push(job.transferId); // fail closed: intent stays open, untouched
      return;
    }
    mine.set(op.sourceTokenId, token);
  }
  try {
    await ctx.machine.resumeIntent({
      transferId: job.transferId,
      payload: job.payload,
      sources: mine,
      journaled: job.journaled,
    });
    report.resumed.push(job.transferId);
  } catch (err) {
    await classifyResumeFailure(ctx.deps, ctx.stores, job.transferId, err, report);
  }
}

async function classifyResumeFailure(
  deps: MachineDeps,
  stores: MachineStores,
  transferId: string,
  err: unknown,
  report: ResumeReport
): Promise<void> {
  if (classifyError(err) === 'conflict') {
    // E.2 pure lost race — nothing was delivered under this intent: soft-abort,
    // never apply the foreign proof; the caller re-plans under a NEW transferId.
    try {
      await deps.intents.abort(transferId);
      await stores.backstop.drop(transferId);
    } catch {
      /* retried at the next resume */
    }
    report.conflicted.push(transferId);
    return;
  }
  const code = err !== null && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  if (code === 'SPLIT_CHECKPOINT_LOST' || code === 'CHECKPOINT_TRUSTBASE_MISMATCH') {
    deps.emit('transfer:attention', { transferId, code: ATTENTION_CHECKPOINT_STUCK, detail: String(code) });
  }
  report.failed.push(transferId);
}

function validatePayload(raw: unknown): IntentPayload {
  const p = raw !== null && typeof raw === 'object' ? (raw as Partial<IntentPayload>) : null;
  if (p === null || p.v !== 2 || !Array.isArray(p.direct) || p.direct.some((t) => typeof t !== 'string')) {
    throw new SphereError(
      `unsupported intent payload shape (v=${String((raw as { v?: unknown } | null)?.v)}) — not resumable`,
      'VALIDATION_ERROR'
    );
  }
  if (typeof p.recipient !== 'string' || typeof p.coinId !== 'string' || typeof p.amount !== 'string') {
    throw new SphereError('intent payload is missing recipient/coinId/amount', 'VALIDATION_ERROR');
  }
  const s = p.split;
  if (
    s !== undefined &&
    (typeof s.tokenId !== 'string' || typeof s.splitAmount !== 'string' || typeof s.remainderAmount !== 'string')
  ) {
    throw new SphereError('intent payload split spec is malformed', 'VALIDATION_ERROR');
  }
  return p as IntentPayload;
}
