// §5.5/§5.6 of docs/PAYMENTS-V2-DESIGN.md — ONE machine for send AND resume.
// Persisted state is the server intent + the E.4 checkpoint + the delivery
// journal; every transition is pinned by tests/unit/payments-v2/machine*.test.ts.

import { sha256 } from '@noble/hashes/sha2.js';

import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { SphereError } from '../../../core/errors';
import type { TransferResult } from '../../../types';
import type { ITokenEngine, SplitCheckpointStore } from '../../../token-engine/engine';
import type { SphereToken } from '../../../token-engine/types';
import type { DeliverOptions, DeliveryPort, StoragePort } from '../ports';
import {
  CANCEL_UNCONFIRMED_MESSAGE,
  INTENT_UNCONFIRMED_MESSAGE,
  NOT_FENCED_MESSAGE,
  PARTLY_ON_CHAIN_MESSAGE,
  asPossiblyCommitted,
} from '../send-errors';
import { coinIdOf, splitOf } from './payload-view';
import type { DeliveryJournalEntry, ScopedKV, ShortfallEntry } from '../stores';
import type { IntentPayload, OpOutcome, OutcomeClass, PlannedOp } from './types';
import { buildOps, classifyError, conflictAmount } from './outcomes';
import { keepAndPost, settledRecord, type OutboxDeps } from './settled-history';
import {
  ATTENTION_DELIVERY_DEFERRED,
  RATE_LIMIT_DEFER_MS,
  abortAndConfirm,
  createMachineStores,
  isNeverStorable,
  isPreWriteRefusal,
  isRateLimited,
  senderNametagOption,
  settleOwed,
  type AttentionEmitter,
  type MachineStores,
} from './journal';

export { buildOps, classifyError } from './outcomes';

// #746: measured live, a 4-op wave cost the same as an 8-op wave — at 8 we were
// latency-bound, so each wave paid a proof round-trip and the barrier multiplied
// it. Safe to widen only because a rate-limited submit now retries instead of
// burning a full deadline per op (proof-wait.retryTransient).
const CERTIFY_WIDTH = 20;

// #835: at most 3 PUTs, issued at once — the heartbeat owns waiting, and an immediate
// re-PUT serializes behind an in-flight original at the DB (wallet-api #107).
const PUT_CONFIRM_RETRIES = 2;

export interface IntentApi {
  put(transferId: string, envelope: string, requiresSeedClose: boolean): Promise<void>;
  listOpen(): Promise<{ transferId: string; payload: string; createdAt: string }[]>;
  listAborted(): Promise<{ transferId: string }[]>;
  abort(transferId: string): Promise<void>;
  complete(transferId: string, signature?: string): Promise<void>;
}

export interface MachineDeps {
  /** Snapshot taken once per operation entry (the setEngine hot-swap seam). */
  engine: () => ITokenEngine;
  storage: StoragePort;
  delivery: DeliveryPort;
  intents: IntentApi;
  checkpointStore: SplitCheckpointStore;
  kv: ScopedKV;
  encryptPayload: (p: IntentPayload) => Promise<string>;
  decryptPayload: (envelope: string) => Promise<unknown>;
  signComplete: (transferId: string) => Promise<string>;
  ownPubkey: Uint8Array;
  /** sphere#487: the wallet's own Unicity ID — see {@link senderNametagOption}. */
  ownNametag?: () => string | undefined;
  emit: (event: string, payload: unknown) => void;
  now: () => number;
  recordSplit?: (sourceTokenId: string, outputTokenId: string) => Promise<void>;
  /**
   * `committedAmount` = what SETTLED (the certified recipient blobs' value), never the plan.
   * Resolves `false` only when a retry may still record it (#842: the SENT outbox keeps it).
   */
  recordHistory?: (info: {
    transferId: string;
    payload: IntentPayload;
    phase: 'sent' | 'resumed';
    committedAmount: string;
    /** A WHOLE-token spend moves the token, not an amount: its real assets, [] when coinless. */
    committedAssets?: readonly { coinId: string; amount: string }[];
    /** #842: when the record was kept — the row's time, re-posts included. */
    timestamp?: number;
  }) => Promise<boolean | void>;
  /** #842: a SENT record was kept for a re-post — wake the convergence heartbeat. */
  armHeartbeat?: () => void;
  /** #842: runs a detached store write only while the owner runs, and tracks it so stop() waits. */
  whileLive?: (write: () => Promise<unknown>) => void;
}

export interface MachinePlan {
  transferId: string;
  recipientPubkey: string;
  payload: IntentPayload;
  ops: PlannedOp[];
  /** Source SphereTokens keyed by tokenId — materialized (blob-fetched) pre-run. */
  sources: Map<string, SphereToken>;
  memo?: string;
}

export interface RehydratedIntent {
  transferId: string;
  payload: IntentPayload;
  sources: Map<string, SphereToken>;
  journaled: Map<number, DeliveryJournalEntry>;
}

export interface ResumeIntentOutcome {
  deliveryPending: boolean;
  /** Non-null when ≥1 leg delivered but a later leg conflicted (#677/#690). */
  partial: ShortfallEntry | null;
  /** False when the close failed after the apply (#835): resume closes it later. */
  closed: boolean;
}

interface CertifyCtx {
  transferId: string;
  recipientPubkey: string;
  payload: IntentPayload;
  memo?: string;
}

interface ResumeConflict {
  op: PlannedOp;
  error: unknown;
  amount: bigint;
}

/** Precedence keep-open > conflict > other; committed = certified regardless of error (#441). */
/** Settlement tolerates conflicts and nothing else; `cls` cannot say that, because
 *  it ranks conflict ABOVE 'other' and so hides an ordinary failure (#745 review). */
export function firstNonConflictError(outcomes: OpOutcome[]): OpOutcome | undefined {
  return outcomes.find((o) => o.error !== undefined && classifyError(o.error) !== 'conflict');
}

export function summarize(outcomes: OpOutcome[]): {
  committed: OpOutcome[];
  cls: OutcomeClass | null;
  firstError: unknown;
} {
  const committed = outcomes.filter((o) => o.certified);
  const rank: Record<OutcomeClass, number> = { 'keep-open': 3, conflict: 2, other: 1 };
  let cls: OutcomeClass | null = null;
  let firstError: unknown;
  for (const o of outcomes) {
    if (o.error === undefined) continue;
    const c = classifyError(o.error);
    if (cls === null || rank[c] > rank[cls]) {
      cls = c;
      firstError = o.error;
    }
  }
  return { committed, cls, firstError };
}

export class TransferMachine {
  private readonly stores: MachineStores;
  /** Bumped by every §5.1 reseed, and the ones still running: an overlapping one may re-PUT an attempt behind its back. */
  private reseedSeq = 0;
  private activeReseeds = 0;
  /** Attempts whose gate saw ≥1 ambiguous PUT answer before its 2xx (#835). */
  private readonly uncertainPuts = new WeakSet<MachinePlan>();
  /** In-process memory of what run() certified — the facade decides from this, never the KV. */
  private readonly certified = new WeakMap<MachinePlan, readonly string[]>();
  /** Parked ids, kept in memory too: the 'unconfirmed' flag write may itself fail. The converger drops one once its hold ends. */
  readonly parked = new Set<string>();

  constructor(private readonly deps: MachineDeps) {
    this.stores = createMachineStores(deps.kv);
  }

  /** #835: a reseed that STARTED before an attempt may still list and re-PUT it, so it counts until it ends. */
  noteReseed(started = true): void {
    if (started) this.reseedSeq += 1;
    this.activeReseeds += started ? 1 : -1;
  }

  /** Source tokenIds whose op run() certified for this plan; [] when none did. */
  certifiedSourcesOf(plan: MachinePlan): readonly string[] {
    return this.certified.get(plan) ?? [];
  }

  // ── send path ─────────────────────────────────────────────────────────────
  async run(plan: MachinePlan): Promise<{ committed: OpOutcome[]; deliveryPending: boolean }> {
    const engine = this.deps.engine();
    const reseedAtStart = this.reseedSeq;
    const envelope = await this.deps.encryptPayload(plan.payload);
    await this.stores.backstop.upsert({
      transferId: plan.transferId,
      payloadEnvelope: envelope,
      requiresSeedClose: plan.payload.split !== undefined,
      disposition: 'open',
      intentPut: 'pending',
      createdAt: this.deps.now(),
    });
    await this.putIntentGate(plan, envelope);
    await this.markAcked(plan.transferId);

    const outcomes = await this.certifyAll(plan, engine);
    const { committed, cls } = summarize(outcomes);
    if (committed.length > 0) this.certified.set(plan, committed.map((o) => o.op.sourceTokenId));

    let deliveryPending = false;
    if (committed.length > 0) {
      deliveryPending = await this.deliverSet(plan.transferId, plan.recipientPubkey, plan.memo, committed);
    }
    if (cls === null) {
      // #842: every leg certified, so SENT is kept and leaves before the apply — an applied row is never listed again.
      const sent = await settledRecord(engine, { transferId: plan.transferId, payload: plan.payload, phase: 'sent', committed });
      await keepAndPost(this.outbox(), sent);
      await this.applyCommitted(engine, plan.transferId, committed);
      this.closeTail(plan.transferId, plan.payload);
      return { committed, deliveryPending };
    }
    // #835: an unsettled attempt is never applied here — resume applies it, after its shortfall.
    throw await this.failureOf(plan, outcomes, reseedAtStart);
  }

  // ── resume path: the SAME machine, rehydrated from an open intent ─────────
  async resumeIntent(r: RehydratedIntent): Promise<ResumeIntentOutcome> {
    const engine = this.deps.engine();
    const ctx: CertifyCtx = {
      transferId: r.transferId,
      recipientPubkey: r.payload.recipient,
      payload: r.payload,
      ...(r.payload.memo !== undefined ? { memo: r.payload.memo } : {}),
    };
    const outcomes = await this.resumeOps(ctx, engine, r);
    const { committed } = summarize(outcomes);
    const conflicts = this.toConflicts(engine, r, outcomes);
    // #835: a pure conflict only — a keep-open or ordinary outcome beside it wins below.
    if (committed.length === 0 && conflicts.length > 0 && firstNonConflictError(outcomes) === undefined) throw conflicts[0].error;

    let deliveryPending = false;
    if (committed.length > 0) {
      deliveryPending = await this.deliverSet(r.transferId, r.payload.recipient, r.payload.memo, committed);
    }
    // An intent closes only when every op settled cleanly (#744) — judged per
    // outcome, since a conflict outranks and would hide an ordinary failure whose
    // amount is in neither committed[] nor conflicts[] (#745 review).
    const blocking = firstNonConflictError(outcomes);
    if (blocking !== undefined) throw blocking.error;

    if (conflicts.length > 0) {
      const settled = await this.settlePartial(engine, r, committed, conflicts);
      return { deliveryPending, partial: settled.entry, closed: settled.closed };
    }
    await this.applyRecorded(engine, r, committed, () => this.completeIntent(r.transferId, r.payload));
    await this.finishBookkeeping(r.transferId);
    return { deliveryPending, partial: null, closed: true };
  }

  // ── shared transitions ─────────────────────────────────────────────────────

  /**
   * #835 E.3: confirm the intent row before any engine op, re-PUTting the SAME stored
   * envelope. 413/422 or two pre-write 4xx with nothing ambiguous before them prove no
   * row exists (refused, clean); anything else that never reached a 2xx parks it.
   */
  private async putIntentGate(plan: MachinePlan, envelope: string): Promise<void> {
    const seal = plan.payload.split !== undefined;
    let ambiguous = false;
    let last: unknown;
    for (let attempt = 0; attempt <= PUT_CONFIRM_RETRIES; attempt++) {
      try {
        await this.deps.intents.put(plan.transferId, envelope, seal);
        if (ambiguous) this.uncertainPuts.add(plan);
        return;
      } catch (err) {
        last = err;
        // #670, widened to 413 — proof only with nothing ambiguous before it: a mixed fleet may have stored that PUT.
        if (isNeverStorable(err) && !ambiguous) return this.refuseIntent(plan.transferId, err);
        if (!isPreWriteRefusal(err)) ambiguous = true;
        else if (attempt > 0 && !ambiguous) return this.refuseIntent(plan.transferId, err);
      }
    }
    if (!ambiguous) return this.refuseIntent(plan.transferId, last); // unreachable; keeps the gate total
    return this.parkIntent(plan.transferId, last);
  }

  /** The wire error is the verdict; a leftover entry is still 'pending', so inert until S1 sweeps it. */
  private async refuseIntent(transferId: string, err: unknown): Promise<never> {
    try {
      await this.stores.backstop.removeByKey(transferId);
    } catch {
      /* the reseed skips 'pending', and resume acts only on a row no PUT created */
    }
    throw err;
  }

  private async parkIntent(transferId: string, last: unknown): Promise<never> {
    this.parked.add(transferId);
    try {
      await this.stores.backstop.patch(transferId, (e) => ({ ...e, intentPut: 'unconfirmed' }));
    } catch {
      /* `parked` covers this process; the converger re-PUTs it from memory and re-persists the hold */
    }
    throw asPossiblyCommitted(last, transferId, INTENT_UNCONFIRMED_MESSAGE);
  }

  private async markAcked(transferId: string): Promise<void> {
    try {
      await this.stores.backstop.patch(transferId, ({ intentPut: _acked, ...rest }) => rest);
    } catch (err) {
      return this.parkIntent(transferId, err); // no op runs on an entry the reseed and S1 read as never acked
    }
  }

  /**
   * #835: what a failed attempt REPORTS. Clean only when nothing certified and nothing
   * can run it: every op conflicted, or the server confirmed the abort while no other PUT
   * of these bytes could still land and re-open the aborted row.
   */
  private async failureOf(plan: MachinePlan, outcomes: OpOutcome[], reseedAtStart: number): Promise<unknown> {
    const { committed, cls, firstError } = summarize(outcomes);
    if (cls === 'keep-open') return firstError; // E.2/E.3: open; the facade stamps it
    const ordinary = firstNonConflictError(outcomes);
    if (committed.length > 0) {
      // ≥1 leg certified: never abort, never apply here. Pure conflicts beside it
      // converge in-process; anything else (a journal write too) is possibly-committed.
      return ordinary === undefined
        ? firstError
        : asPossiblyCommitted(ordinary.error, plan.transferId, PARTLY_ON_CHAIN_MESSAGE);
    }
    if (outcomes.length === plan.ops.length && outcomes.every((o) => classifyError(o.error) === 'conflict')) {
      await this.fence(plan.transferId); // any re-run conflicts again: clean whatever the fence did
      return firstError;
    }
    // Checked synchronously before fence() enqueues its tombstone: a reseed that starts
    // later lists or re-reads the tombstone and skips it; one still running may not.
    if (this.uncertainPuts.has(plan) || this.reseedSeq !== reseedAtStart || this.activeReseeds > 0) {
      return asPossiblyCommitted(firstError, plan.transferId, NOT_FENCED_MESSAGE);
    }
    const unfenced = await this.fence(plan.transferId);
    return unfenced === undefined ? firstError : asPossiblyCommitted(firstError, plan.transferId, unfenced);
  }

  /** E.2 abort, durable first: undefined once fenced, else the message its possibly-committed report carries. */
  private async fence(transferId: string): Promise<string | undefined> {
    let tombstoned = false;
    try {
      tombstoned =
        (await this.stores.backstop.patch(transferId, (e) => ({ ...e, disposition: 'abortPending' }))) !== undefined;
    } catch {
      /* no tombstone: leave the intent OPEN so the possibly-committed report converges */
    }
    if (!tombstoned) return NOT_FENCED_MESSAGE;
    const outcome = await abortAndConfirm(this.deps.intents, transferId); // until then another device could run it
    if (outcome === 'unknown' || outcome === 'completed') return CANCEL_UNCONFIRMED_MESSAGE;
    try {
      await this.stores.backstop.removeByKey(transferId);
    } catch {
      /* a lingering tombstone is dropped once the server confirms the abort */
    }
    return undefined;
  }

  private async certifyAll(plan: MachinePlan, engine: ITokenEngine): Promise<OpOutcome[]> {
    const ctx: CertifyCtx = {
      transferId: plan.transferId,
      recipientPubkey: plan.recipientPubkey,
      payload: plan.payload,
      ...(plan.memo !== undefined ? { memo: plan.memo } : {}),
    };
    const outcomes: OpOutcome[] = [];
    const certified: OpOutcome[] = [];
    for (let at = 0; at < plan.ops.length; at += CERTIFY_WIDTH) {
      const batch = plan.ops.slice(at, at + CERTIFY_WIDTH);
      const settled = await Promise.all(
        batch.map((op) =>
          this.certifyOne(ctx, engine, op, plan.sources.get(op.sourceTokenId)).then((o) => {
            // Report each leg as it lands, not each wave: a <=CERTIFY_WIDTH send is
            // one wave, so per-wave reporting would jump 0% -> 100%. Rides the
            // existing transfer:updated / tokenTransfers surface — nothing new.
            if (o.certified) {
              certified.push(o);
              this.emitProgress(plan, certified);
            }
            return o;
          })
        )
      );
      outcomes.push(...settled);
      if (settled.some((o) => o.error !== undefined && !o.certified)) break;
    }
    return outcomes;
  }

  /** In-flight snapshot: `tokenTransfers` holds the legs certified SO FAR. */
  private emitProgress(plan: MachinePlan, certified: readonly OpOutcome[]): void {
    try {
      this.deps.emit('transfer:updated', {
        id: plan.transferId,
        status: 'submitted',
        tokens: [],
        tokenTransfers: certified.map((o) => ({
          sourceTokenId: o.op.sourceTokenId,
          method: o.op.kind,
        })),
      } satisfies TransferResult);
    } catch {
      /* #835: a listener's throw must never turn a certified leg into a failed send */
    }
  }

  private async certifyOne(
    ctx: CertifyCtx,
    engine: ITokenEngine,
    op: PlannedOp,
    source: SphereToken | undefined
  ): Promise<OpOutcome> {
    if (source === undefined) {
      return {
        op,
        certified: false,
        error: new SphereError(`source ${op.sourceTokenId} is not materialized`, 'VALIDATION_ERROR'),
      };
    }
    let produced: { recipientBlob: Uint8Array; changeBlob?: Uint8Array };
    try {
      produced = await this.certifyOnChain(ctx, engine, op, source);
    } catch (error) {
      return { op, certified: false, error };
    }
    const outcome: OpOutcome = { op, certified: true, ...produced };
    try {
      // #621: journal the instant the op certifies, BEFORE any delivery attempt.
      await this.stores.deliveryJournal.upsert({
        transferId: ctx.transferId,
        opIndex: op.opIndex,
        recipientPubkey: ctx.recipientPubkey,
        blobHex: bytesToHex(produced.recipientBlob),
        ...(ctx.memo !== undefined ? { memo: ctx.memo } : {}),
        attempts: 0,
      });
      return outcome;
    } catch (error) {
      return { ...outcome, error };
    }
  }

  private async certifyOnChain(
    ctx: CertifyCtx,
    engine: ITokenEngine,
    op: PlannedOp,
    source: SphereToken
  ): Promise<{ recipientBlob: Uint8Array; changeBlob?: Uint8Array }> {
    const recipientPubkey = hexToBytes(ctx.recipientPubkey);
    const opts = { transferId: ctx.transferId, opIndex: op.opIndex, checkpointStore: this.deps.checkpointStore };
    if (op.kind === 'direct') {
      const finished = await engine.transfer({ token: source, recipientPubkey }, opts);
      return { recipientBlob: finished.blob.token };
    }
    const split = splitOf(ctx.payload)!;
    // A split is planned only for a coin spend, so the coin id is present by
    // construction; a token-addressed intent never reaches this branch.
    const splitCoinId = coinIdOf(ctx.payload)!;
    const { outputs } = await engine.split(
      {
        token: source,
        outputs: [
          { recipientPubkey, coinId: splitCoinId, amount: BigInt(split.splitAmount) },
          { recipientPubkey: this.deps.ownPubkey, coinId: splitCoinId, amount: BigInt(split.remainderAmount) },
        ],
      },
      opts
    );
    return { recipientBlob: outputs[0].blob.token, changeBlob: outputs[1].blob.token };
  }

  /** Raw outcomes; `summarize` alone decides what they mean — same as the send path. */
  private async resumeOps(
    ctx: CertifyCtx,
    engine: ITokenEngine,
    r: RehydratedIntent
  ): Promise<OpOutcome[]> {
    const outcomes: OpOutcome[] = [];
    for (const op of buildOps(r.payload)) {
      // #621 direct legs re-deliver from the journal, never re-certify; a split
      // ALWAYS re-runs through its E.4 checkpoint to recover the change (#634).
      const journaled = op.kind === 'direct' ? r.journaled.get(op.opIndex) : undefined;
      if (journaled !== undefined) {
        outcomes.push({ op, certified: true, recipientBlob: hexToBytes(journaled.blobHex) });
        continue;
      }
      outcomes.push(await this.certifyOne(ctx, engine, op, r.sources.get(op.sourceTokenId)));
      // Fail-fast on anything but a conflict, as before — but the outcome is
      // RECORDED, so the shared decision below sees it (#744).
      const last = outcomes[outcomes.length - 1];
      if (last.error !== undefined && classifyError(last.error) !== 'conflict') break;
    }
    return outcomes;
  }

  /** Conflicted ops with the amount each leaves undelivered (#690 shortfall math). */
  private toConflicts(engine: ITokenEngine, r: RehydratedIntent, outcomes: OpOutcome[]): ResumeConflict[] {
    return outcomes
      .filter((o) => !o.certified && classifyError(o.error) === 'conflict')
      .map((o) => ({
        op: o.op,
        error: o.error,
        amount: conflictAmount(engine, r.payload, o.op, r.sources.get(o.op.sourceTokenId)),
      }));
  }

  private async deliverSet(
    transferId: string,
    recipientPubkey: string,
    memo: string | undefined,
    committed: OpOutcome[]
  ): Promise<boolean> {
    const journaled = committed.filter((o) => o.error === undefined && o.recipientBlob !== undefined);
    let pending = journaled.length < committed.length;
    if (journaled.length === 0) return pending;
    const options = {
      transferId,
      ...(memo !== undefined ? { memo } : {}),
      ...senderNametagOption(this.deps.ownNametag),
    };
    if (await this.tryBatchDeposit(recipientPubkey, journaled, options)) return pending;
    for (const outcome of journaled) {
      // #835: certified already — a failed defer/recordFailure leaves the entry for the replay.
      const stillPending = await this.deliverOne(recipientPubkey, outcome, options).catch(() => true);
      pending = pending || stillPending;
    }
    return pending;
  }

  private async tryBatchDeposit(
    recipientPubkey: string,
    journaled: OpOutcome[],
    options: DeliverOptions
  ): Promise<boolean> {
    const batch = this.deps.delivery.deliverBatch?.bind(this.deps.delivery);
    if (batch === undefined) return false;
    try {
      await batch(recipientPubkey, journaled.map((o) => o.recipientBlob!), options);
    } catch {
      return false; // §5.6: batch failure falls back to the per-entry loop
    }
    for (const o of journaled) await this.removeJournaled(options.transferId, o.op.opIndex);
    return true;
  }

  private async deliverOne(
    recipientPubkey: string,
    outcome: OpOutcome,
    options: DeliverOptions
  ): Promise<boolean> {
    try {
      await this.deps.delivery.deliver(recipientPubkey, outcome.recipientBlob!, options);
      await this.removeJournaled(options.transferId, outcome.op.opIndex);
      return false;
    } catch (err) {
      if (isRateLimited(err)) {
        await this.stores.deliveryJournal.defer(options.transferId, outcome.op.opIndex, this.deps.now() + RATE_LIMIT_DEFER_MS);
        this.attention()(options.transferId, ATTENTION_DELIVERY_DEFERRED);
      } else {
        await this.stores.deliveryJournal.recordFailure(options.transferId, outcome.op.opIndex, this.attention());
      }
      return true;
    }
  }

  private async removeJournaled(transferId: string, opIndex: number): Promise<void> {
    try {
      await this.stores.deliveryJournal.remove(transferId, opIndex);
    } catch {
      /* deposit is idempotent — the replay converges a lingering entry */
    }
  }

  private async applyCommitted(engine: ITokenEngine, transferId: string, committed: OpOutcome[]): Promise<void> {
    try {
      const added = await this.uploadChangeBlobs(engine, committed);
      await this.deps.storage.applyDelta({
        transferId,
        spent: committed.map((o) => o.op.sourceTokenId),
        added,
      });
    } catch (cause) {
      // #665: post-commit mirror lag — never transfer:failed; resume converges.
      const pending = new SphereError(
        'The spend committed on-chain; the wallet-api mirror is catching up.',
        'SEND_SYNC_PENDING',
        cause
      );
      pending.transferId = transferId;
      throw pending;
    }
  }

  private async uploadChangeBlobs(
    engine: ITokenEngine,
    committed: OpOutcome[]
  ): Promise<{ tokenId: string; key: string }[]> {
    const added: { tokenId: string; key: string }[] = [];
    for (const o of committed) {
      if (o.changeBlob === undefined) continue;
      const digest = bytesToHex(sha256(o.changeBlob));
      const keys = await this.deps.storage.uploadBlobs([{ sha256: digest, bytes: o.changeBlob }]);
      const key = keys.get(digest);
      if (key === undefined) throw new SphereError(`no upload key returned for ${digest}`, 'STORAGE_ERROR');
      const { tokenId } = await engine.deliveryKeys(o.changeBlob);
      await this.deps.recordSplit?.(o.op.sourceTokenId, tokenId);
      added.push({ tokenId, key });
    }
    return added;
  }

  private async settlePartial(
    engine: ITokenEngine,
    r: RehydratedIntent,
    committed: OpOutcome[],
    conflicts: ResumeConflict[]
  ): Promise<{ entry: ShortfallEntry; closed: boolean }> {
    const undelivered = conflicts.reduce((sum, c) => sum + c.amount, 0n);
    const entry: ShortfallEntry = {
      transferId: r.transferId,
      remainingAmount: undelivered.toString(),
      // '' only on a token-addressed intent, which is one leg: it either lands or
      // conflicts, so a shortfall row is unreachable there (settlePartial needs >1).
      coinId: coinIdOf(r.payload) ?? '',
      recipient: r.payload.recipient,
      committedTokenIds: committed.map((o) => o.op.sourceTokenId),
      createdAt: this.deps.now(),
    };
    // #690 + #835: durable BEFORE the apply — the apply completes an unflagged intent,
    // after which it is unlistable and no resume could rebuild the unseen remainder.
    await this.stores.shortfalls.upsert(entry);
    const close = (): Promise<boolean> => this.completeIntent(r.transferId, r.payload).then(() => true, () => false);
    const closed = await this.applyRecorded(engine, r, committed, close);
    // An unclosed partial keeps its backstop: the next pass closes it (idempotent).
    if (closed) await this.finishBookkeeping(r.transferId);
    return { entry, closed };
  }

  /** #842: SENT is kept and leaves before the apply, never awaited: the outbox re-posts what does not land. */
  private async applyRecorded<T>(engine: ITokenEngine, r: RehydratedIntent, committed: OpOutcome[], close: () => Promise<T>): Promise<T> {
    const sent = await settledRecord(engine, { transferId: r.transferId, payload: r.payload, phase: 'resumed', committed });
    await keepAndPost(this.outbox(), sent);
    await this.applyCommitted(engine, r.transferId, committed);
    return close();
  }

  private outbox(): OutboxDeps {
    const { recordHistory, encryptPayload, now, armHeartbeat, whileLive } = this.deps;
    return { recordHistory, encryptPayload, now, armHeartbeat, whileLive, outbox: this.stores.sentOutbox };
  }

  private closeTail(transferId: string, payload: IntentPayload): void {
    void (async () => {
      try {
        await this.completeIntent(transferId, payload);
      } catch {
        return; // idempotent backstop — resume converges the unevidenced edge
      }
      await this.finishBookkeeping(transferId);
    })();
  }

  private async completeIntent(transferId: string, payload: IntentPayload): Promise<void> {
    const signature = payload.split !== undefined ? await this.deps.signComplete(transferId) : undefined;
    await this.deps.intents.complete(transferId, signature);
  }

  private async finishBookkeeping(transferId: string): Promise<void> {
    try {
      await settleOwed(this.stores, await this.stores.backstop.getByKey(transferId));
      await this.stores.backstop.removeByKey(transferId);
    } catch {
      /* a stale unflagged 'open' entry is residue — S1 sweeps it once the row is closed */
    }
  }

  private attention(): AttentionEmitter {
    return (transferId, code, detail) => {
      this.deps.emit('transfer:attention', detail === undefined ? { transferId, code } : { transferId, code, detail });
    };
  }
}
