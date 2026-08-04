// §5.5/§5.6 of docs/PAYMENTS-V2-DESIGN.md — ONE machine for send AND resume.
// Persisted state is the server intent + the E.4 checkpoint + the delivery
// journal; every transition is pinned by tests/unit/payments-v2/machine*.test.ts.

import { sha256 } from '@noble/hashes/sha2.js';

import { bytesToHex, hexToBytes } from '../../../core/crypto';
import { SphereError } from '../../../core/errors';
import type { ITokenEngine, SplitCheckpointStore } from '../../../token-engine/engine';
import type { SphereToken } from '../../../token-engine/types';
import {
  CheckpointPersistFailedError,
  CheckpointTrustbaseMismatchError,
  ProofUnconfirmedError,
  SplitCheckpointLostError,
  TransferConflictError,
} from '../../../token-engine/errors';
import type { DeliveryPort, StoragePort } from '../ports';
import type { DeliveryJournalEntry, ScopedKV, ShortfallEntry } from '../stores';
import type { IntentPayload, OpOutcome, OutcomeClass, PlannedOp } from './types';
import {
  ATTENTION_DELIVERY_DEFERRED,
  ATTENTION_SYNC_PENDING,
  RATE_LIMIT_DEFER_MS,
  createMachineStores,
  isRateLimited,
  isValidationReject,
  type AttentionEmitter,
  type MachineStores,
} from './journal';

const CERTIFY_WIDTH = 8;

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
  emit: (event: string, payload: unknown) => void;
  now: () => number;
  recordHistory?: (info: { transferId: string; payload: IntentPayload; phase: 'sent' | 'resumed' }) => Promise<void>;
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
      this.closeTail(plan.transferId, plan.payload);
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
    const { committed, conflicts } = await this.resumeOps(ctx, engine, r);
    if (committed.length === 0 && conflicts.length > 0) throw conflicts[0].error;

    let deliveryPending = false;
    if (committed.length > 0) {
      deliveryPending = await this.deliverSet(r.transferId, r.payload.recipient, r.payload.memo, committed);
    }
    await this.applyCommitted(engine, r.transferId, committed);
    if (conflicts.length > 0) {
      return { deliveryPending, partial: await this.settlePartial(r, committed, conflicts) };
    }
    await this.completeIntent(r.transferId, r.payload);
    await this.finishBookkeeping(r.transferId, r.payload, 'resumed');
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
    for (let at = 0; at < plan.ops.length; at += CERTIFY_WIDTH) {
      const batch = plan.ops.slice(at, at + CERTIFY_WIDTH);
      const settled = await Promise.all(
        batch.map((op) => this.certifyOne(ctx, engine, op, plan.sources.get(op.sourceTokenId)))
      );
      outcomes.push(...settled);
      if (settled.some((o) => o.error !== undefined && !o.certified)) break;
    }
    return outcomes;
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

  private async resumeOps(
    ctx: CertifyCtx,
    engine: ITokenEngine,
    r: RehydratedIntent
  ): Promise<{ committed: OpOutcome[]; conflicts: ResumeConflict[] }> {
    const committed: OpOutcome[] = [];
    const conflicts: ResumeConflict[] = [];
    for (const op of buildOps(r.payload)) {
      // #621 direct legs re-deliver from the journal, never re-certify; a split
      // ALWAYS re-runs through its E.4 checkpoint to recover the change (#634).
      const journaled = op.kind === 'direct' ? r.journaled.get(op.opIndex) : undefined;
      if (journaled !== undefined) {
        committed.push({ op, certified: true, recipientBlob: hexToBytes(journaled.blobHex) });
        continue;
      }
      const source = r.sources.get(op.sourceTokenId);
      const outcome = await this.certifyOne(ctx, engine, op, source);
      if (outcome.certified) {
        committed.push(outcome);
        continue;
      }
      if (classifyError(outcome.error) !== 'conflict') throw outcome.error;
      conflicts.push({ op, error: outcome.error, amount: conflictAmount(engine, r.payload, op, source) });
    }
    return { committed, conflicts };
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
    const options = { transferId, ...(memo !== undefined ? { memo } : {}) };
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
    options: { transferId: string; memo?: string }
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
    options: { transferId: string; memo?: string }
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
    await this.finishBookkeeping(r.transferId, r.payload, 'resumed');
    return entry;
  }

  private closeTail(transferId: string, payload: IntentPayload): void {
    void (async () => {
      try {
        await this.completeIntent(transferId, payload);
      } catch {
        return; // idempotent backstop — resume converges the unevidenced edge
      }
      await this.finishBookkeeping(transferId, payload, 'sent');
    })();
  }

  private async completeIntent(transferId: string, payload: IntentPayload): Promise<void> {
    const signature = payload.split !== undefined ? await this.deps.signComplete(transferId) : undefined;
    await this.deps.intents.complete(transferId, signature);
  }

  private async finishBookkeeping(transferId: string, payload: IntentPayload, phase: 'sent' | 'resumed'): Promise<void> {
    try {
      await this.deps.recordHistory?.({ transferId, payload, phase });
    } catch {
      /* a history failure never fails the money path */
    }
    try {
      await this.stores.backstop.removeByKey(transferId);
    } catch {
      /* stale 'open' backstops are inert — resume lists server-open only */
    }
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
