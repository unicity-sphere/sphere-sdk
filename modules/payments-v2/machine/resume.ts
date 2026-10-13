// §5.5 P6 — resume = the SAME TransferMachine, rehydrated from server-open
// intents: the #676 local-disposition gate, v:2 payload validation, batched
// cross-intent source reads, and {resumed, conflicted, failed} classification.

import { SphereError } from '../../../core/errors';
import { logger } from '../../../core/logger';
import type { SphereToken } from '../../../token-engine/types';
import type { DeliveryJournalEntry, IntentBackstopEntry } from '../stores';
import { isWholeIntent } from './payload-view';
import type { CoinIntentPayload, IntentPayload, WholeIntentPayload } from './types';
import {
  ATTENTION_CHECKPOINT_STUCK,
  createMachineStores,
  isNeverStorable,
  isUnknownIntent,
  releaseOwed,
  settleOwed,
  type MachineStores,
} from './journal';
import { TransferMachine, buildOps, classifyError, type IntentApi, type MachineDeps } from './TransferMachine';

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

export interface ResumeAllOptions {
  /** Ids with an in-process machine attempt — their backstop entries are never GC'd. */
  isLocallyActive?: (transferId: string) => boolean;
  /** #835: ids the machine parked in memory (their 'unconfirmed' flag write failed). */
  isParked?: (transferId: string) => boolean;
  /** #835: a held id the ensure step confirmed or dropped — its in-memory park is done. */
  onHoldEnded?: (transferId: string) => void;
  /** #835: the pass deferred on an unreadable backstop — its report proves nothing. */
  onDeferred?: () => void;
}

/** One pass's local picture: the backstop snapshot, the server-open ids, the in-process verdicts. */
interface LocalView {
  locals: Map<string, IntentBackstopEntry>;
  openIds: Set<string>;
  isLocallyActive: (transferId: string) => boolean;
  isParked: (transferId: string) => boolean;
  onHoldEnded: (transferId: string) => void;
}

export async function resumeAll(deps: MachineDeps, options: ResumeAllOptions = {}): Promise<ResumeReport> {
  const report: ResumeReport = { resumed: [], conflicted: [], failed: [] };
  const stores = createMachineStores(deps.kv);
  const open = await deps.intents.listOpen();

  let locals: Map<string, IntentBackstopEntry>;
  try {
    locals = new Map((await stores.backstop.list()).map((e) => [e.transferId, e]));
  } catch {
    // #676: local dispositions unknowable — a server-open intent could be
    // locally aborted, so resuming ANY would risk re-executing one. Defer all.
    options.onDeferred?.();
    return report;
  }
  const view: LocalView = {
    locals,
    openIds: new Set(open.map((i) => i.transferId)),
    isLocallyActive: options.isLocallyActive ?? (() => false),
    isParked: options.isParked ?? (() => false),
    onHoldEnded: options.onHoldEnded ?? (() => undefined),
  };
  const confirmed = await confirmUnconfirmed(deps, stores, view, report);
  await dropStaleBackstops(deps.intents, stores, view, report);

  const jobs = await gateAndDecode(deps, stores, [...open, ...confirmed], locals, report);
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

function isHeld(entry: IntentBackstopEntry, view: LocalView): boolean {
  return entry.intentPut === 'unconfirmed' || view.isParked(entry.transferId);
}

/**
 * #835 ensure step, before anything resumes or is swept: a send reported
 * SEND_SYNC_PENDING because its PUT never answered 2xx gets its STORED envelope
 * re-PUT. Confirmed → returned, so this same pass resumes it with the same bytes;
 * 413/422 → nothing ever ran: dropped, reported conflicted; otherwise kept.
 */
async function confirmUnconfirmed(
  deps: MachineDeps,
  stores: MachineStores,
  view: LocalView,
  report: ResumeReport
): Promise<{ transferId: string; payload: string }[]> {
  const confirmed: { transferId: string; payload: string }[] = [];
  for (const listed of [...view.locals.values()]) {
    const id = listed.transferId;
    if (listed.disposition !== 'open' || !isHeld(listed, view) || view.isLocallyActive(id)) continue;
    if (view.openIds.has(id)) {
      await unflag(stores, view.locals, listed); // the row is there: gateAndDecode resumes it this pass
      view.onHoldEnded(id);
      continue;
    }
    // Held in memory only (its flag write failed): every pass re-persists the hold, so a
    // restart finds it held instead of sweeping a 'pending' entry as residue.
    const entry = listed.intentPut === 'unconfirmed' ? listed : await persistHold(stores, view.locals, listed);
    try {
      await deps.intents.put(id, entry.payloadEnvelope, entry.requiresSeedClose);
    } catch (err) {
      const dropped =
        isNeverStorable(err) &&
        !(await listedNow(deps, id)) &&
        (await releaseOwed(stores, entry)
          .then(() => stores.backstop.removeIfUnchanged(id, entry))
          .catch(() => false));
      if (dropped) {
        view.locals.delete(id);
        view.onHoldEnded(id);
      }
      (dropped ? report.conflicted : report.failed).push(id);
      continue;
    }
    await unflag(stores, view.locals, entry);
    view.onHoldEnded(id);
    view.openIds.add(id); // confirmed: S1 must not sweep it this pass
    confirmed.push({ transferId: id, payload: entry.payloadEnvelope });
  }
  return confirmed;
}

/** #835: a 413/422 says nothing about a held send's earlier ambiguous PUT; a listing taken after it does. */
async function listedNow(deps: MachineDeps, transferId: string): Promise<boolean> {
  return (await deps.intents.listOpen().catch(() => [{ transferId }])).some((i) => i.transferId === transferId);
}

/** Best-effort: on a failed write the hold stays in memory and the next pass tries again. */
async function persistHold(
  stores: MachineStores,
  locals: Map<string, IntentBackstopEntry>,
  entry: IntentBackstopEntry
): Promise<IntentBackstopEntry> {
  try {
    const held = await stores.backstop.patch(entry.transferId, (e) => ({ ...e, intentPut: 'unconfirmed' }));
    if (held === undefined) return entry;
    locals.set(entry.transferId, held);
    return held;
  } catch {
    return entry;
  }
}

async function unflag(
  stores: MachineStores,
  locals: Map<string, IntentBackstopEntry>,
  entry: IntentBackstopEntry
): Promise<void> {
  if (entry.intentPut === undefined) return; // parked in memory only, already unflagged on disk
  try {
    const stripped = await stores.backstop.patch(entry.transferId, ({ intentPut: _confirmed, ...rest }) => rest);
    if (stripped !== undefined) locals.set(entry.transferId, stripped);
  } catch {
    /* still flagged: the next pass finds the row listed and unflags it then */
  }
}

/**
 * Reconciliation GC (never money logic — when in doubt, KEEP the entry). Every
 * removal is compare-and-delete against the snapshot judged (#835), and an
 * in-process attempt is never touched. A tombstone goes only once the server
 * answers its abort 2xx or 404 NOT_FOUND. S1: an unflagged 'open' entry that is
 * NOT server-open with no journal legs owed is residue (completed-or-never).
 */
async function dropStaleBackstops(
  intents: IntentApi,
  stores: MachineStores,
  view: LocalView,
  report: ResumeReport
): Promise<void> {
  for (const entry of view.locals.values()) {
    const id = entry.transferId;
    if (view.openIds.has(id) || view.isLocallyActive(id)) continue;
    if (entry.disposition !== 'open') {
      try {
        await intents.abort(id);
      } catch (err) {
        if (!isUnknownIntent(err)) continue;
      }
      // A confirmed cancel of an attempt that certified nothing: conflicted, so a link to it is payable again.
      if (await stores.backstop.removeIfUnchanged(id, entry)) report.conflicted.push(id);
      continue;
    }
    if (isHeld(entry, view)) continue; // reported possibly-committed: the ensure step owns it
    if ((await stores.deliveryJournal.byTransfer(id)).size > 0) continue;
    await settleOwed(stores, entry);
    await stores.backstop.removeIfUnchanged(id, entry);
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
      // #676: a locally-aborted intent is NEVER resumed — converge the server. Conflicted
      // only once the server confirmed the abort (#835): until then another device of
      // this wallet could still run the open row, so a payment link stays settling.
      let aborted = true;
      try {
        await deps.intents.abort(intent.transferId);
      } catch {
        aborted = false; // stays locally aborted; converged at the next resume
      }
      if (aborted) await stores.backstop.removeByKey(intent.transferId).catch(() => undefined);
      (aborted ? report.conflicted : report.failed).push(intent.transferId);
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
      decoded.set(tokenId, await engine.decodeToken({ tokenId, token: bytes }));
    } catch (err) {
      logger.warn('PaymentsV2', `resume: source ${tokenId} did not decode — ${String(err)}`);
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
    // The blob is the authority on what a source carries — the same rule the send
    // path applies at materialize. A durable intent labelled whole whose named
    // source actually holds coins would move them while history records assets: [].
    if (isWholeIntent(job.payload) && token.valueEnvelope === 'bare_collection') {
      logger.warn(
        'PaymentsV2',
        `resume: token intent ${job.transferId} names a source carrying coin value — refusing`
      );
      report.failed.push(job.transferId);
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
      await releaseOwed(stores, await stores.backstop.getByKey(transferId)); // #835: its remainder is owed again
      await stores.backstop.removeByKey(transferId);
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

/**
 * A token-addressed intent is EXACTLY one named source and never a split. Both are
 * enforced here rather than trusted: a second leg would make `settlePartial`
 * reachable with every conflict amount 0n, so a remainder of '0' would complete the
 * intent and report success for a leg that never landed.
 */
function validateCoinPayload(c: Partial<CoinIntentPayload>): CoinIntentPayload {
  if (typeof c.coinId !== 'string' || typeof c.amount !== 'string') {
    throw new SphereError('intent payload is missing coinId/amount', 'VALIDATION_ERROR');
  }
  const s = c.split;
  if (
    s !== undefined &&
    (typeof s.tokenId !== 'string' || typeof s.splitAmount !== 'string' || typeof s.remainderAmount !== 'string')
  ) {
    throw new SphereError('intent payload split spec is malformed', 'VALIDATION_ERROR');
  }
  return { ...(c as CoinIntentPayload), kind: 'coin' };
}

function validateWholePayload(p: Partial<WholeIntentPayload>): WholeIntentPayload {
  if (p.direct?.length !== 1 || typeof p.direct[0] !== 'string' || p.direct[0] === '') {
    throw new SphereError(
      'token intent payload must name exactly one source token',
      'VALIDATION_ERROR'
    );
  }
  if (p.split !== undefined) {
    throw new SphereError('token intent payload cannot carry a split', 'VALIDATION_ERROR');
  }
  return { ...(p as WholeIntentPayload), kind: 'whole', direct: [p.direct[0]] };
}

function validatePayload(raw: unknown): IntentPayload {
  const p = raw !== null && typeof raw === 'object' ? (raw as Partial<IntentPayload>) : null;
  if (p === null || p.v !== 2 || !Array.isArray(p.direct) || p.direct.some((t) => typeof t !== 'string')) {
    throw new SphereError(
      `unsupported intent payload shape (v=${String((raw as { v?: unknown } | null)?.v)}) — not resumable`,
      'VALIDATION_ERROR'
    );
  }
  if (typeof p.recipient !== 'string') {
    throw new SphereError('intent payload is missing recipient', 'VALIDATION_ERROR');
  }
  // ABSENT migrates to 'coin' (the only pre-#777 shape); an EXPLICIT unknown one
  // does NOT. 'coinless' is 0.17.0's spelling of 'whole' — durable server state, so
  // a client that wrote one must still resume it.
  const kind = p.kind ?? 'coin';
  if (kind !== 'coin' && kind !== 'whole' && kind !== 'coinless') {
    throw new SphereError(
      `unsupported intent kind '${String(kind)}' — not resumable by this client`,
      'VALIDATION_ERROR'
    );
  }
  return kind === 'coin'
    ? validateCoinPayload(p as Partial<CoinIntentPayload>)
    : validateWholePayload(p as Partial<WholeIntentPayload>);
}
