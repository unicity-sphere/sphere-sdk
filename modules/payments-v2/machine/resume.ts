// §5.5 P6 — resume = the SAME TransferMachine, rehydrated from server-open
// intents: the #676 local-disposition gate, v:2 payload validation, batched
// cross-intent source reads, and {resumed, conflicted, failed} classification.

import { SphereError } from '../../../core/errors';
import { logger } from '../../../core/logger';
import type { SphereToken } from '../../../token-engine/types';
import type { StoragePort } from '../ports';
import type { DeliveryJournalEntry, IntentBackstopEntry } from '../stores';
import { isWholeIntent } from './payload-view';
import type { CoinIntentPayload, IntentPayload, PlannedOp, WholeIntentPayload } from './types';
import {
  ATTENTION_CHECKPOINT_STUCK,
  abortAndConfirm,
  createMachineStores,
  isNeverStorable,
  releaseOwed,
  retryAfterMsOf,
  settleOwed,
  type AbortOutcome,
  type MachineStores,
} from './journal';
import { TransferMachine, buildOps, classifyError, type IntentApi, type MachineDeps } from './TransferMachine';

export interface ResumeReport {
  resumed: string[];
  conflicted: string[];
  failed: string[];
  /** The longest Retry-After a failed intent's answer carried: the heartbeat waits it out. */
  retryAfterMs?: number;
  /** #840: never-stored cancels, removed only once the reconcile ran and no settling link names them. */
  retireAfterReconcile?: IntentBackstopEntry[];
}

function noteWait(report: ResumeReport, err: unknown): void {
  const wait = retryAfterMsOf(err);
  if (wait !== null) report.retryAfterMs = Math.max(report.retryAfterMs ?? 0, wait);
}

function noteFailed(report: ResumeReport, transferId: string, err: unknown): void {
  report.failed.push(transferId);
  noteWait(report, err);
}

interface ResumeJob {
  transferId: string;
  payload: IntentPayload;
  ops: PlannedOp[];
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
  /** #840: ids whose refusal was already logged — one warning per intent, not one per pass. */
  warned?: Set<string>;
}

/** #840: what a pass judged, and the payloads it refused to plan (kept apart: never budgeted or settled). */
interface PassState {
  report: ResumeReport;
  gated: string[];
  refused: string[];
  warned: Set<string>;
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
  const pass: PassState = {
    report,
    gated: open.map((i) => i.transferId),
    refused: [],
    warned: options.warned ?? new Set(),
  };
  try {
    await runPass(deps, stores, view, open, pass);
  } catch (err) {
    // #840: what the pass already decided is still reported; every id not judged yet stays open.
    noteWait(report, err); // defensive: every remote call in the pass catches its own wait today
    const judged = new Set([...report.resumed, ...report.conflicted, ...report.failed, ...pass.refused]);
    report.failed.push(...pass.gated.filter((id) => !judged.has(id)));
  }
  report.failed.push(...pass.refused);
  return report;
}

async function runPass(
  deps: MachineDeps,
  stores: MachineStores,
  view: LocalView,
  open: { transferId: string; payload: string }[],
  pass: PassState
): Promise<void> {
  const confirmed = await confirmUnconfirmed(deps, stores, view, pass.report);
  pass.gated.push(...confirmed.map((c) => c.transferId));
  await dropStaleBackstops(deps.intents, stores, view, pass.report);

  const jobs = await gateAndDecode(deps, stores, [...open, ...confirmed], view.locals, pass);
  const ctx: RunCtx = {
    deps,
    stores,
    machine: new TransferMachine(deps),
    sources: await fetchSources(deps, jobs, pass.report),
  };
  for (const job of jobs) {
    await runOne(ctx, job, pass.report);
  }
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
      const paid = isNeverStorable(err) && (await completedElsewhere(deps, id, report));
      const ended = paid && (await endHold(stores, entry).catch(() => false));
      if (ended) {
        view.locals.delete(id);
        view.onHoldEnded(id); // unaccounted, so a linked request reads paid
      } else noteFailed(report, id, err);
      continue;
    }
    await unflag(stores, view.locals, entry);
    view.onHoldEnded(id);
    view.openIds.add(id); // confirmed: S1 must not sweep it this pass
    confirmed.push({ transferId: id, payload: entry.payloadEnvelope });
  }
  return confirmed;
}

/** #835: a 413/422 says nothing of a held send's earlier PUT, which may still land and create or re-open
 *  its row: no absence proves it refused, so only a row completed elsewhere ends the hold. */
async function completedElsewhere(deps: MachineDeps, id: string, report: ResumeReport): Promise<boolean> {
  const noted = (err: unknown): null => {
    noteWait(report, err);
    return null;
  };
  const open = await deps.intents.listOpen().catch(noted);
  if (open === null || open.some((i) => i.transferId === id)) return false;
  return (await abortAndConfirm(deps.intents, id, (err) => noteWait(report, err))) === 'completed';
}

async function endHold(stores: MachineStores, entry: IntentBackstopEntry): Promise<boolean> {
  await settleOwed(stores, entry);
  return stores.backstop.removeIfUnchanged(entry.transferId, entry);
}

/** A confirmed cancel moved nothing: what it held is owed again, conflicted (a link is payable); a completed row was paid. */
async function retire(
  stores: MachineStores,
  entry: IntentBackstopEntry,
  outcome: Exclude<AbortOutcome, 'unknown'>,
  report: ResumeReport
): Promise<void> {
  const refused = outcome !== 'completed';
  await (refused ? releaseOwed(stores, entry) : settleOwed(stores, entry));
  if (outcome === 'never-stored') {
    // #840: no listing ever shows it, so the entry is the verdict's only durable copy. It no longer
    // holds what it handed back: a later pass must not owe again a remainder already paid.
    report.conflicted.push(entry.transferId);
    (report.retireAfterReconcile ??= []).push((await stripOwed(stores, entry)) ?? entry);
  } else if ((await stores.backstop.removeIfUnchanged(entry.transferId, entry)) && refused) {
    report.conflicted.push(entry.transferId);
  }
}

/** On a failed write the rows stay held, so hidden, and the next pass hands them back again. */
async function stripOwed(stores: MachineStores, entry: IntentBackstopEntry): Promise<IntentBackstopEntry | undefined> {
  if (entry.owes === undefined) return entry;
  return stores.backstop.patch(entry.transferId, ({ owes: _handedBack, ...rest }) => rest).catch(() => undefined);
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
      const outcome = await abortAndConfirm(intents, id, (err) => noteWait(report, err));
      if (outcome !== 'unknown') await retire(stores, entry, outcome, report);
      continue;
    }
    if (isHeld(entry, view)) continue; // reported possibly-committed: the ensure step owns it
    if ((await stores.deliveryJournal.byTransfer(id)).size > 0) continue;
    // Read for each entry: a byte-equal re-PUT may re-open a row while an earlier one is retired.
    const listed = await freshListings(intents, report);
    // Unknown until both listings read; open again (a byte-equal re-PUT re-opened it): a later pass judges it.
    if (listed === null || listed.open.has(id)) continue;
    await retire(stores, entry, listed.aborted.has(id) ? 'aborted' : 'completed', report);
  }
}

async function freshListings(
  intents: IntentApi,
  report: ResumeReport
): Promise<{ aborted: Set<string>; open: Set<string> } | null> {
  const ids = (rows: { transferId: string }[]): Set<string> => new Set(rows.map((row) => row.transferId));
  const noted = (err: unknown): null => {
    noteWait(report, err);
    return null;
  };
  const aborted = await intents.listAborted().then(ids, noted);
  const open = aborted === null ? null : await intents.listOpen().then(ids, noted);
  return aborted === null || open === null ? null : { aborted, open };
}

async function gateAndDecode(
  deps: MachineDeps,
  stores: MachineStores,
  open: { transferId: string; payload: string }[],
  locals: Map<string, IntentBackstopEntry>,
  pass: PassState
): Promise<ResumeJob[]> {
  const { report } = pass;
  const jobs: ResumeJob[] = [];
  for (const intent of open) {
    const local = locals.get(intent.transferId);
    if (local !== undefined && local.disposition !== 'open') {
      // #676: never resumed. Conflicted only once the cancel is confirmed (#835): until then another device could run it.
      const outcome = await abortAndConfirm(deps.intents, intent.transferId, (err) => noteWait(report, err));
      if (outcome === 'unknown') report.failed.push(intent.transferId);
      else await retire(stores, local, outcome, report).catch(() => undefined);
      continue;
    }
    let payload: IntentPayload;
    let ops: PlannedOp[];
    try {
      payload = validatePayload(await deps.decryptPayload(intent.payload));
      ops = buildOps(payload); // #840: planned per intent, so one that cannot plan fails alone
    } catch (err) {
      refuse(pass, intent.transferId, err);
      continue;
    }
    jobs.push({
      transferId: intent.transferId,
      payload,
      ops,
      journaled: await stores.deliveryJournal.byTransfer(intent.transferId),
    });
  }
  return jobs;
}

/** #840: a payload this client cannot plan is reported failed and left open — never run, aborted or completed. */
function refuse(pass: PassState, transferId: string, err: unknown): void {
  pass.refused.push(transferId);
  if (pass.warned.has(transferId)) return;
  pass.warned.add(transferId);
  logger.warn('PaymentsV2', `resume: intent ${transferId} is not resumable — ${String(err)}`);
}

/** The sources a job still has to read: every op but a journaled direct leg. */
function neededBy(job: ResumeJob): string[] {
  return job.ops.filter((op) => op.kind !== 'direct' || !job.journaled.has(op.opIndex)).map((op) => op.sourceTokenId);
}

/** One batched blob read across every intent (§7 start() posture). Jobs whose source is missing fail closed below. */
async function fetchSources(
  deps: MachineDeps,
  jobs: ResumeJob[],
  report: ResumeReport
): Promise<Map<string, SphereToken>> {
  const decoded = new Map<string, SphereToken>();
  const needed = new Set(jobs.flatMap(neededBy));
  if (needed.size === 0) return decoded;
  const blobs = await readBlobs(deps.storage, [...needed], jobs, report);
  try {
    const engine = deps.engine();
    for (const [tokenId, bytes] of blobs) {
      try {
        decoded.set(tokenId, await engine.decodeToken({ tokenId, token: bytes }));
      } catch (err) {
        logger.warn('PaymentsV2', `resume: source ${tokenId} did not decode — ${String(err)}`);
      }
    }
  } catch (err) {
    noteWait(report, err); // no engine: nothing decodes
  }
  return decoded;
}

/** #840: the server refuses a whole batch over one id (malformed, not owned, one download failed): read per job. */
async function readBlobs(
  storage: StoragePort,
  ids: string[],
  jobs: ResumeJob[],
  report: ResumeReport
): Promise<Map<string, Uint8Array>> {
  try {
    return await storage.getBlobs(ids);
  } catch (err) {
    noteWait(report, err);
    if (retryAfterMsOf(err) !== null) return new Map(); // asked to back off: a read per job only adds load
  }
  const blobs = new Map<string, Uint8Array>();
  const own = jobs.map(neededBy).filter((needed) => needed.length > 0);
  if (own.length < 2) return blobs; // the batch was one job's own read
  for (const needed of own) {
    try {
      for (const [id, bytes] of await storage.getBlobs(needed)) blobs.set(id, bytes);
    } catch (err) {
      noteWait(report, err);
      if (retryAfterMsOf(err) !== null) break; // asked to back off: the jobs left fail closed
    }
  }
  return blobs;
}

async function runOne(ctx: RunCtx, job: ResumeJob, report: ResumeReport): Promise<void> {
  const mine = new Map<string, SphereToken>();
  for (const op of job.ops) {
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
  noteFailed(report, transferId, err);
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
    (typeof s.tokenId !== 'string' || !isAssetValue(s.splitAmount) || !isAssetValue(s.remainderAmount))
  ) {
    throw new SphereError('intent payload split spec is malformed', 'VALIDATION_ERROR');
  }
  // #840: the engine refuses a non-hex coin at the split leg, after the direct legs spent.
  if (s !== undefined && !/^(?:[0-9a-f]{2})+$/.test(c.coinId)) {
    throw new SphereError('intent payload coinId is not canonical hex', 'VALIDATION_ERROR');
  }
  return { ...(c as CoinIntentPayload), kind: 'coin' };
}

const ASSET_VALUE_BOUND = 1n << 256n;

/** #840: a value the engine accepts, [1, 2^256), in the one form every writer emits (bigint toString). */
function isAssetValue(s: unknown): boolean {
  return typeof s === 'string' && /^[1-9]\d*$/.test(s) && BigInt(s) < ASSET_VALUE_BOUND;
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
