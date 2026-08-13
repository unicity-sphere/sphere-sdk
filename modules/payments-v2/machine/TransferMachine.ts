// §5.5/§5.6 of docs/PAYMENTS-V2-DESIGN.md — ONE machine for send AND resume.
// Persisted state is the server intent + the E.4 checkpoint + the delivery
// journal; every transition is pinned by tests/unit/payments-v2/machine*.test.ts.

import { sha256 } from '@noble/hashes/sha2.js';

import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { SphereError } from '../../../core/errors';
import type { TransferResult } from '../../../types';
import type { ITokenEngine, SplitCheckpointStore } from '../../../token-engine/engine';
import type { SphereToken } from '../../../token-engine/types';
import { TOKEN_BLOB_VERSION } from '../../../token-engine/token-blob';
import {
  CheckpointPersistFailedError,
  CheckpointTrustbaseMismatchError,
  ProofUnconfirmedError,
  SplitCheckpointLostError,
  TransferConflictError,
} from '../../../token-engine/errors';
import type { DeliverOptions, DeliveryPort, StoragePort } from '../ports';
import type { DeliveryJournalEntry, ScopedKV, ShortfallEntry } from '../stores';
import type { IntentPayload, OpOutcome, OutcomeClass, PlannedOp } from './types';
import {
  ATTENTION_DELIVERY_DEFERRED,
  ATTENTION_SYNC_PENDING,
  RATE_LIMIT_DEFER_MS,
  createMachineStores,
  isRateLimited,
  isValidationReject,
  senderNametagOption,
  type AttentionEmitter,
  type MachineStores,
} from './journal';

// #746: measured live, a 4-op wave cost the same as an 8-op wave — at 8 we were
// latency-bound, so each wave paid a proof round-trip and the barrier multiplied
// it. Safe to widen only because a rate-limited submit now retries instead of
// burning a full deadline per op (proof-wait.retryTransient).
const CERTIFY_WIDTH = 20;

const KEEP_OPEN_CODES = new Set([
  'CERTIFICATION_UNCONFIRMED',
  'CHECKPOINT_PERSIST_FAILED',
  'SPLIT_CHECKPOINT_LOST',
  'CHECKPOINT_TRUSTBASE_MISMATCH',
]);

export interface IntentApi {
  put(transferId: string, envelope: string, requiresSeedClose: boolean): Promise<void>;
  listOpen(): Promise<{ transferId: string; payload: string; createdAt: string }[]>;
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
  /** `committedAmount` = what SETTLED (the certified recipient blobs' value), never the plan. */
  recordHistory?: (info: {
    transferId: string;
    payload: IntentPayload;
    phase: 'sent' | 'resumed';
    committedAmount: string;
  }) => Promise<void>;
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

/** opIndex is plan-derived: the op's position in direct[], split at direct.length (E.1). */
export function buildOps(payload: IntentPayload): PlannedOp[] {
  const ops: PlannedOp[] = payload.direct.map((sourceTokenId, opIndex) => ({
    kind: 'direct',
    opIndex,
    sourceTokenId,
    deliveredAmount: 0n,
  }));
  if (payload.split !== undefined) {
    ops.push({
      kind: 'split',
      opIndex: payload.direct.length,
      sourceTokenId: payload.split.tokenId,
      deliveredAmount: BigInt(payload.split.splitAmount),
    });
  }
  return ops;
}

export function classifyError(e: unknown): OutcomeClass {
  if (
    e instanceof ProofUnconfirmedError ||
    e instanceof SplitCheckpointLostError ||
    e instanceof CheckpointPersistFailedError ||
    e instanceof CheckpointTrustbaseMismatchError
  ) {
    return 'keep-open';
  }
  if (e instanceof TransferConflictError) return 'conflict';
  const coded = e !== null && typeof e === 'object' ? (e as { code?: unknown; mayHaveCertified?: unknown }) : null;
  if (coded !== null) {
    if (coded.mayHaveCertified === true) return 'keep-open';
    if (typeof coded.code === 'string' && KEEP_OPEN_CODES.has(coded.code)) return 'keep-open';
    if (coded.code === 'TRANSFER_CONFLICT') return 'conflict';
  }
  return 'other';
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

  constructor(private readonly deps: MachineDeps) {
    this.stores = createMachineStores(deps.kv);
  }

  // ── send path ─────────────────────────────────────────────────────────────
  async run(plan: MachinePlan): Promise<{ committed: OpOutcome[]; deliveryPending: boolean }> {
    const engine = this.deps.engine();
    const envelope = await this.deps.encryptPayload(plan.payload);
    await this.stores.backstop.upsert({
      transferId: plan.transferId,
      payloadEnvelope: envelope,
      requiresSeedClose: plan.payload.split !== undefined,
      disposition: 'open',
      createdAt: this.deps.now(),
    });
    await this.putIntentGate(plan, envelope);

    const outcomes = await this.certifyAll(plan, engine);
    const { committed, cls, firstError } = summarize(outcomes);

    let deliveryPending = false;
    if (committed.length > 0) {
      deliveryPending = await this.deliverSet(plan.transferId, plan.recipientPubkey, plan.memo, committed);
    }
    if (cls === null) {
      await this.applyCommitted(engine, plan.transferId, committed);
      this.closeTail(engine, plan.transferId, plan.payload, committed);
      return { committed, deliveryPending };
    }
    if (cls === 'conflict' && committed.length > 0) {
      await this.applyBestEffort(engine, plan.transferId, committed);
    }
    await this.disposeOnFailure(plan.transferId, committed, cls);
    throw firstError;
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
    if (committed.length === 0 && conflicts.length > 0) throw conflicts[0].error;

    let deliveryPending = false;
    if (committed.length > 0) {
      deliveryPending = await this.deliverSet(r.transferId, r.payload.recipient, r.payload.memo, committed);
    }
    // An intent closes only when every op settled cleanly (#744) — judged per
    // outcome, since a conflict outranks and would hide an ordinary failure whose
    // amount is in neither committed[] nor conflicts[] (#745 review).
    const blocking = firstNonConflictError(outcomes);
    if (blocking !== undefined) throw blocking.error;

    await this.applyCommitted(engine, r.transferId, committed);
    if (conflicts.length > 0) {
      return { deliveryPending, partial: await this.settlePartial(engine, r, committed, conflicts) };
    }
    await this.completeIntent(r.transferId, r.payload);
    await this.finishBookkeeping(engine, r.transferId, r.payload, 'resumed', committed);
    return { deliveryPending, partial: null };
  }

  // ── shared transitions ─────────────────────────────────────────────────────

  private async putIntentGate(plan: MachinePlan, envelope: string): Promise<void> {
    try {
      await this.deps.intents.put(plan.transferId, envelope, plan.payload.split !== undefined);
    } catch (err) {
      // #670: only the deterministic pre-submit 422 proves no server row exists.
      if (isValidationReject(err)) await this.stores.backstop.removeByKey(plan.transferId);
      throw err;
    }
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
    this.deps.emit('transfer:updated', {
      id: plan.transferId,
      status: 'submitted',
      tokens: [],
      tokenTransfers: certified.map((o) => ({
        sourceTokenId: o.op.sourceTokenId,
        method: o.op.kind,
      })),
    } satisfies TransferResult);
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
    const split = ctx.payload.split!;
    const { outputs } = await engine.split(
      {
        token: source,
        outputs: [
          { recipientPubkey, coinId: ctx.payload.coinId, amount: BigInt(split.splitAmount) },
          { recipientPubkey: this.deps.ownPubkey, coinId: ctx.payload.coinId, amount: BigInt(split.remainderAmount) },
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
      const stillPending = await this.deliverOne(recipientPubkey, outcome, options);
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

  private async applyBestEffort(engine: ITokenEngine, transferId: string, committed: OpOutcome[]): Promise<void> {
    if (committed.some((o) => o.error !== undefined)) return; // unjournaled leg: resume owns it
    try {
      await this.applyCommitted(engine, transferId, committed);
    } catch {
      this.attention()(transferId, ATTENTION_SYNC_PENDING);
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
      added.push({ tokenId, key });
    }
    return added;
  }

  private async settlePartial(
    engine: ITokenEngine,
    r: RehydratedIntent,
    committed: OpOutcome[],
    conflicts: ResumeConflict[]
  ): Promise<ShortfallEntry> {
    const undelivered = conflicts.reduce((sum, c) => sum + c.amount, 0n);
    const entry: ShortfallEntry = {
      transferId: r.transferId,
      remainingAmount: undelivered.toString(),
      coinId: r.payload.coinId,
      recipient: r.payload.recipient,
      committedTokenIds: committed.map((o) => o.op.sourceTokenId),
      createdAt: this.deps.now(),
    };
    // #690: durable BEFORE complete — after complete the intent is unlistable
    // and no resume could ever rebuild the remainder the app never saw.
    await this.stores.shortfalls.upsert(entry);
    await this.completeIntent(r.transferId, r.payload);
    await this.finishBookkeeping(engine, r.transferId, r.payload, 'resumed', committed);
    return entry;
  }

  private closeTail(engine: ITokenEngine, transferId: string, payload: IntentPayload, committed: OpOutcome[]): void {
    void (async () => {
      try {
        await this.completeIntent(transferId, payload);
      } catch {
        return; // idempotent backstop — resume converges the unevidenced edge
      }
      await this.finishBookkeeping(engine, transferId, payload, 'sent', committed);
    })();
  }

  private async completeIntent(transferId: string, payload: IntentPayload): Promise<void> {
    const signature = payload.split !== undefined ? await this.deps.signComplete(transferId) : undefined;
    await this.deps.intents.complete(transferId, signature);
  }

  private async finishBookkeeping(
    engine: ITokenEngine,
    transferId: string,
    payload: IntentPayload,
    phase: 'sent' | 'resumed',
    committed: OpOutcome[]
  ): Promise<void> {
    try {
      const committedAmount = await this.settledAmount(engine, payload.coinId, committed);
      await this.deps.recordHistory?.({ transferId, payload, phase, committedAmount });
    } catch {
      /* a history failure never fails the money path */
    }
    try {
      await this.stores.backstop.removeByKey(transferId);
    } catch {
      /* stale 'open' backstops are inert — resume lists server-open only */
    }
  }

  /**
   * §5.9: SENT history records what SETTLED, never the plan — the value of the
   * certified recipient blobs (summarize()'s committed set is the only source;
   * a journal-rehydrated resume leg has no source token, but every committed
   * leg carries its recipient blob, so the outcome-derived rule is uniform).
   */
  private async settledAmount(engine: ITokenEngine, coinId: string, committed: OpOutcome[]): Promise<string> {
    let total = 0n;
    for (const outcome of committed) {
      if (outcome.recipientBlob === undefined) continue;
      const token = await engine.decodeToken({
        v: TOKEN_BLOB_VERSION,
        network: 0,
        tokenId: '',
        token: outcome.recipientBlob,
      });
      total += engine.balanceOf(token, coinId);
    }
    return total.toString();
  }

  private async disposeOnFailure(transferId: string, committed: OpOutcome[], cls: OutcomeClass): Promise<void> {
    // Abort ONLY when nothing certified AND the class is clean; the keep-open
    // family and any partially-certified send leave the intent open (E.2/E.3).
    if (committed.length > 0 || cls === 'keep-open') return;
    try {
      await this.stores.backstop.patch(transferId, (e) => ({ ...e, disposition: 'abortPending' }));
    } catch {
      /* server abort below still converges; #676 gate covers the gap */
    }
    try {
      await this.deps.intents.abort(transferId);
      await this.stores.backstop.removeByKey(transferId);
    } catch {
      /* stays abortPending — the #676 resume gate converges, never re-executes */
    }
  }

  private attention(): AttentionEmitter {
    return (transferId, code, detail) => {
      this.deps.emit('transfer:attention', detail === undefined ? { transferId, code } : { transferId, code, detail });
    };
  }
}

function conflictAmount(
  engine: ITokenEngine,
  payload: IntentPayload,
  op: PlannedOp,
  source: SphereToken | undefined
): bigint {
  if (op.kind === 'split') return BigInt(payload.split!.splitAmount);
  return source !== undefined ? engine.balanceOf(source, payload.coinId) : 0n;
}
