// §4 of docs/PAYMENTS-V2-DESIGN.md — the PaymentsV2 facade. The send() POLICY
// lives here (bounded re-plan, remainder accumulation, keep-open rethrow);
// the TransferMachine stays policy-free. Wiring lives in compose.ts.

import { sha256 } from '@noble/hashes/sha2.js';

import { bytesToHex } from '../../core/crypto';
import {
  PartialSendConflictError,
  SphereError,
  isPossiblyCommittedSendOutcome,
} from '../../core/errors';
import { randomUUID } from '../../core/uuid';
import type { ITokenEngine } from '../../token-engine/engine';
import type { SphereToken } from '../../token-engine/types';
import { TOKEN_BLOB_VERSION } from '../../token-engine/token-blob';
import type { Asset, IncomingTransfer, Token, TokenTransferDetail, TransferResult } from '../../types';

import type { ConnectionStatus, HistoryPage, MintResult, PaymentsV2, PendingTransfer, SendRequest } from './api';
import { SerialChain, SingleFlight } from './async';
import { ConvergenceHeartbeat, Converger, derivePendingTransfers } from './convergence';
import { requireSameNetworkRecipient } from './recipient';
import { reseedAndReset, type RestoreDeps } from './restore';
import { mintParams } from './mint-params';
import { PrewarmCache, takeSourceBlobs, warmSendSources, type WarmDeps } from './prewarm-cache';
import type { MintJournalEntry, ShortfallEntry } from './stores';
import type { History } from './history/History';
import type { InventoryView } from './inventory/InventoryView';
import { transferringToken } from './inventory/presentation';
import type { Receive } from './receive/Receive';
import type { Requests } from './requests/Requests';
import type { ReservationLedger } from './select/ledger';
import type { IntentPins } from './select/pins';
import type { SpendQueue, PlannedSpend } from './select/queue';
import type { MachineStores } from './machine/journal';
import { buildOps, classifyError, type MachineDeps, type MachinePlan, type TransferMachine } from './machine/TransferMachine';
import { buildPayload, messageOf } from './machine/payload';
import {
  composeFacadeParts,
  supportsDeterministicMint,
  type HeldStateCache,
  type PaymentsFacadeDeps,
} from './compose';

export {
  supportsDeterministicMint,
  type CheckpointReseeder,
  type DeterministicMintCapable,
  type FacadeClient,
  type FacadeSession,
  type PaymentsFacadeDeps,
  type RecipientInfo,
} from './compose';
export { ATTENTION_RESEED_REJECTED } from './restore';
export { ATTENTION_RECIPIENT_NETWORK_UNVERIFIED } from './recipient';

/** Max re-plans after a conflicted attempt (#625/#677 parity with the old send loop). */
export const MAX_RESELECT = 8;

export const ATTENTION_MINT_UNRESOLVED = 'mint:unresolved';

const INVENTORY_SCAN_PAGE_LIMIT = 50;

interface AttemptCtx {
  readonly transferId: string;
  readonly coinId: string;
  readonly plan: MachinePlan;
  readonly sourceIds: readonly string[];
  readonly sourceTokens: readonly Token[];
}

type AttemptDisposition =
  | { kind: 'rethrow'; error: unknown }
  | { kind: 'retry-full'; error: unknown }
  | { kind: 'success'; deliveryPending: boolean }
  | { kind: 'partial'; entry: ShortfallEntry; deliveryPending: boolean };

/** Accumulated state of one send() across its internal attempts. */
interface SendRun {
  amount: string;
  delivered: string[];
  sentTokens: Token[];
  tokenTransfers: TokenTransferDetail[];
  settledShortfalls: string[];
  firstPartialId: string | undefined;
  pendingAny: boolean;
  lastTransferId: string; // latest attempt's id ('' pre-plan) — rides a clean-failure emission
}

export class PaymentsFacade implements PaymentsV2 {
  private readonly prewarmed = new PrewarmCache();
  private readonly view: InventoryView;
  private readonly ledger: ReservationLedger;
  private readonly queue: SpendQueue;
  private readonly machine: TransferMachine;
  private readonly machineDeps: MachineDeps;
  private readonly machineStores: MachineStores;
  private readonly historyStore: History;
  private readonly receiveLoop: Receive;
  private readonly heldStates: HeldStateCache;
  private readonly ownPubkeyBytes: Uint8Array;
  private readonly restoreDeps: RestoreDeps;
  readonly requests: Requests;

  private currentEngine: ITokenEngine | null = null;
  private readonly pendingOps = new Set<Promise<void>>();
  private unsubscribers: (() => void)[] = [];
  private started = false;

  // §7 heartbeat: in-memory timing cell + pass runner (see convergence.ts).
  private readonly heartbeat: ConvergenceHeartbeat;
  private readonly converger: Converger;
  /** Resume single-flight (§7): ticks, start() and resumeNow() coalesce onto ONE pass. */
  private readonly resumeFlight = new SingleFlight<void>();
  /** §5.1/§7: restore + convergence passes SERIALIZE here. */
  private readonly passChain = new SerialChain();
  /** §7 ownership: ids with an in-process machine attempt — the pass never adopts one. */
  private readonly activeMoneyOps = new Set<string>();
  /** #737: the ledger holds exactly the sources of the still-open intents. */
  private readonly pins: IntentPins;

  constructor(private readonly deps: PaymentsFacadeDeps) {
    const parts = composeFacadeParts(deps, {
      engine: () => this.engine(),
      send: (request) => this.send(request),
      isActiveOp: (id) => this.activeMoneyOps.has(id),
    });
    this.view = parts.view;
    this.ledger = parts.ledger;
    this.queue = parts.queue;
    this.machine = parts.machine;
    this.machineDeps = parts.machineDeps;
    this.machineStores = parts.machineStores;
    this.historyStore = parts.historyStore;
    this.receiveLoop = parts.receiveLoop;
    this.heldStates = parts.heldStates;
    this.ownPubkeyBytes = parts.ownPubkeyBytes;
    this.restoreDeps = parts.restoreDeps;
    this.requests = parts.requests;
    this.pins = parts.pins;
    deps.deliveryPort.bindDeliveryKeys((blob) => this.engine().deliveryKeys(blob));
    this.heartbeat = new ConvergenceHeartbeat({
      now: () => this.nowMs(),
      onTick: () => this.trackTail(this.runConvergencePass()),
    });
    this.converger = new Converger({
      machineDeps: this.machineDeps,
      stores: this.machineStores,
      delivery: deps.deliveryPort,
      reconcile: (report) => this.requests.reconcile(report),
      refreshView: () => this.view.delta(),
      replayMints: () => this.replayMints(),
      isActiveOp: (id) => this.activeMoneyOps.has(id),
      emit: deps.emit,
      now: () => this.nowMs(),
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.heartbeat.start();
    // Subscriptions BEFORE session.start(): no frame can beat the restore hook.
    this.unsubscribers.push(
      this.deps.session.subscribeEpochChange((epoch) => this.handleEpochChange(epoch)),
      this.deps.session.subscribeStream('mailbox', () => {
        this.trackTail(this.receiveLoop.drainOnce());
      }),
      this.deps.session.subscribeStream('inventory', () => {
        this.trackTail(this.view.delta());
      }),
      this.deps.session.subscribeStream('payment_requests', () => {
        this.trackTail(this.requests.drainIncoming());
      })
    );
    const statusUnsub = this.deps.session.subscribeStatus?.((status) => {
      if (status === 'connected') this.heartbeat.recovered();
    });
    if (statusUnsub !== undefined) this.unsubscribers.push(statusUnsub);
    await this.deps.session.start();
    // BEFORE the first pass and before any send can plan: a source pinned by an
    // intent left open by the previous session must not be re-offered (#737).
    // A rejection leaves the ledger unproven: reads keep working, spending does not (#738).
    await this.pins.sync().catch(() => undefined);
    // §7 start posture: never awaited; the heartbeat re-runs this same pass.
    this.trackTail(this.runConvergencePass());
    this.trackTail(this.seedHeldStates());
    await this.view.fullPull().catch(() => undefined);
    this.receiveLoop.start(this.deps.receivePollMs);
  }

  /** §7 same-address restart gate: resolves only after in-flight ops settle. */
  async stop(): Promise<void> {
    this.started = false;
    this.heartbeat.stop(); // §7 quiescence unchanged: a mid-backoff stop cancels cleanly
    this.receiveLoop.stop();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    await this.deps.session.stop();
    while (this.pendingOps.size > 0) {
      await Promise.allSettled([...this.pendingOps]);
    }
  }

  /** Swaps what FUTURE operations snapshot; in-flight ops finish on the old engine. */
  setEngine(next: ITokenEngine): void {
    const previous = this.currentEngine ?? this.deps.engineRef();
    this.currentEngine = next;
    if (previous !== next) previous.dispose?.();
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  async assets(coinId?: string): Promise<Asset[]> {
    const all = await this.view.assets(this.deps.registry, this.deps.price);
    return coinId === undefined ? all : all.filter((asset) => asset.coinId === coinId);
  }

  tokens(filter?: { coinId?: string }): Token[] {
    return this.view.tokens(this.deps.registry, filter);
  }

  history(page?: { before?: string; limit?: number }): Promise<HistoryPage> {
    return this.historyStore.page(page ?? {});
  }

  /** §4: read through to the session — the same value `connection:status` carries (sphere#473). No session ⇒ 'offline'. */
  connectionStatus(): ConnectionStatus {
    return this.started ? this.deps.session.status() : 'offline';
  }

  /** §4 pending-transfers UI surface — derived on read, never cached (convergence.ts). */
  pendingTransfers(): Promise<PendingTransfer[]> {
    return derivePendingTransfers(this.machineStores, this.machineDeps.decryptPayload);
  }

  // ── money movement ─────────────────────────────────────────────────────────

  async prewarmSend(request: SendRequest): Promise<void> {
    await warmSendSources(this.warmDeps(), request);
  }

  discardPrewarm(): void {
    this.prewarmed.clear();
  }

  private warmDeps(): WarmDeps {
    return { queue: this.queue, view: this.view, storagePort: this.deps.storagePort, cache: this.prewarmed };
  }

  send(request: SendRequest): Promise<TransferResult> {
    return this.track(this.sendOutcome(request));
  }

  async receive(): Promise<{ transfers: IncomingTransfer[] }> {
    const transfers = await this.track(this.receiveLoop.drainOnce());
    if (transfers.length > 0) this.trackTail(this.view.delta());
    return { transfers };
  }

  mint(coinId: string, amount: bigint): Promise<MintResult> {
    return this.track(this.mintInner(coinId, amount));
  }

  // §4 retry verb: coalesces onto the running pass — NEVER re-issue send() (#631/#676).
  async resumeNow(): Promise<void> {
    if (!this.started) return;
    await this.track(this.runConvergencePass());
  }

  /** §5.1 restore — awaited by the session latch BEFORE streams resume; never coalesced onto a pre-restore pass. */
  async handleEpochChange(_newEpoch: string): Promise<void> {
    await this.passChain.enqueue(() => reseedAndReset(this.restoreDeps));
    await this.passChain.enqueue(() => this.convergeBody());
  }

  /** One single-flighted pass + its reschedule: concurrent callers coalesce. */
  private runConvergencePass(): Promise<void> {
    return this.resumeFlight.run(() => this.passChain.enqueue(() => this.convergeBody()));
  }

  private async convergeBody(): Promise<void> {
    const outcome = await this.converger.convergeOnce();
    // After the pass refreshed the mirror: an intent that stopped being open
    // stops pinning, one still open keeps pinning (#737).
    // A rejection leaves the ledger unproven: reads keep working, spending does not (#738).
    await this.pins.sync().catch(() => undefined);
    const pending = await this.converger.pendingWork().catch(() => true);
    this.heartbeat.settle(outcome, pending);
  }

  private nowMs(): number {
    return (this.deps.now ?? Date.now)();
  }

  // ── send policy (§5.5 + old-loop parity; the machine stays policy-free) ────

  /** The ONE place a send() outcome is shaped: success emits in finishSend, a
   *  CLEAN rejection emits `transfer:updated{status:'failed'}` here (§4). */
  private async sendOutcome(request: SendRequest): Promise<TransferResult> {
    const run: SendRun = {
      amount: request.amount,
      delivered: [],
      sentTokens: [],
      tokenTransfers: [],
      settledShortfalls: [],
      firstPartialId: undefined,
      pendingAny: false,
      lastTransferId: '',
    };
    try {
      return await this.sendWithPolicy(request, run);
    } catch (err) {
      this.emitCleanFailure(err, run.lastTransferId);
      throw err;
    }
  }

  /** Only a CLEAN failure (nothing certified, classifyError 'other') is 'failed'.
   *  Keep-open/partial/conflict outcomes are pending/converging — labelling them
   *  'failed' invites a dApp re-send, i.e. a double-pay (#631/#676). */
  private emitCleanFailure(err: unknown, transferId: string): void {
    if (isPossiblyCommittedSendOutcome(err) || classifyError(err) !== 'other') return;
    const failed: TransferResult = {
      id: transferId,
      status: 'failed',
      tokens: [],
      tokenTransfers: [],
      error: messageOf(err),
    };
    this.deps.emit('transfer:updated', failed);
  }

  private async sendWithPolicy(request: SendRequest, run: SendRun): Promise<TransferResult> {
    const recipient = await requireSameNetworkRecipient(this.deps, request.recipient);
    for (let attempt = 0; ; attempt++) {
      let ctx: AttemptCtx;
      try {
        ctx = await this.planAndMaterialize(recipient.chainPubkey, { ...request, amount: run.amount }, run);
      } catch (err) {
        throw this.partialize(err, run);
      }
      const disposition = await this.runAttempt(ctx);
      if (disposition.kind === 'rethrow') throw this.partialize(disposition.error, run);
      if (disposition.kind === 'retry-full') {
        if (attempt >= MAX_RESELECT) throw this.partialize(disposition.error, run);
        continue;
      }
      if (disposition.kind === 'success') {
        run.pendingAny = run.pendingAny || disposition.deliveryPending;
        this.accumulate(ctx, ctx.sourceIds, run);
        return await this.finishSend(ctx.transferId, run);
      }
      const surfaced = await this.consumePartial(ctx, disposition, run, attempt);
      if (surfaced !== null) return surfaced;
    }
  }

  private async runAttempt(ctx: AttemptCtx): Promise<AttemptDisposition> {
    this.activeMoneyOps.add(ctx.transferId);
    try {
      const { deliveryPending } = await this.machine.run(ctx.plan);
      this.settleSuccess(ctx, ctx.sourceIds);
      return { kind: 'success', deliveryPending };
    } catch (err) {
      return await this.disposeFailedAttempt(ctx, err);
    } finally {
      this.activeMoneyOps.delete(ctx.transferId);
    }
  }

  /** Partial (#677/#690): shortfall already durable (machine wrote it BEFORE
   *  complete); accumulate settled, re-plan ONLY the remainder, NEW transferId. */
  private async consumePartial(
    ctx: AttemptCtx,
    disposition: { entry: ShortfallEntry; deliveryPending: boolean },
    run: SendRun,
    attempt: number
  ): Promise<TransferResult | null> {
    if (disposition.deliveryPending) {
      run.pendingAny = true;
      this.heartbeat.arm(); // deposits owed — heartbeat work even if the remainder later throws
    }
    const partial = disposition.entry;
    run.delivered.push(...partial.committedTokenIds);
    run.firstPartialId ??= partial.transferId;
    run.settledShortfalls.push(partial.transferId);
    this.accumulate(ctx, partial.committedTokenIds, run);
    this.settlePartial(ctx, partial);
    if (BigInt(partial.remainingAmount) <= 0n) {
      return this.finishSend(ctx.transferId, run);
    }
    if (attempt >= MAX_RESELECT) {
      throw new PartialSendConflictError(
        'Part of your payment was sent, but the remainder could not be completed within the re-plan budget. The delivered portion is final — re-plan only the shortfall, never the full amount.',
        run.firstPartialId,
        run.delivered,
        partial.remainingAmount
      );
    }
    run.amount = partial.remainingAmount;
    return null;
  }

  /** Failure disposition: possibly-committed → rethrow UNWRAPPED; backstop
   *  'open' → converge via resumeIntent; clean demoted conflict → full re-plan. */
  private async disposeFailedAttempt(ctx: AttemptCtx, err: unknown): Promise<AttemptDisposition> {
    if (isPossiblyCommittedSendOutcome(err)) {
      this.settleKeepOpen(ctx);
      this.stampTransferId(err, ctx.transferId);
      return { kind: 'rethrow', error: err };
    }
    const backstop = await this.machineStores.backstop.getByKey(ctx.transferId);
    if (backstop !== undefined && backstop.disposition === 'open') {
      return this.convergePartial(ctx);
    }
    this.settleFailure(ctx.transferId, ctx.coinId, ctx.sourceIds);
    if (classifyError(err) !== 'conflict') return { kind: 'rethrow', error: err };
    const demoted = await this.demoteSpentSources(ctx);
    return demoted > 0 ? { kind: 'retry-full', error: err } : { kind: 'rethrow', error: err };
  }

  /** #677/#690: ≥1 leg committed — the SAME machine, resumed in-process, converges it. */
  private async convergePartial(ctx: AttemptCtx): Promise<AttemptDisposition> {
    let outcome;
    try {
      outcome = await this.machine.resumeIntent({
        transferId: ctx.transferId,
        payload: ctx.plan.payload,
        sources: ctx.plan.sources,
        journaled: await this.machineStores.deliveryJournal.byTransfer(ctx.transferId),
      });
    } catch (err) {
      return this.disposeConvergeFailure(ctx, err);
    }
    if (outcome.partial === null) {
      this.settleSuccess(ctx, ctx.sourceIds);
      return { kind: 'success', deliveryPending: outcome.deliveryPending };
    }
    return { kind: 'partial', entry: outcome.partial, deliveryPending: outcome.deliveryPending };
  }

  private async disposeConvergeFailure(ctx: AttemptCtx, err: unknown): Promise<AttemptDisposition> {
    if (isPossiblyCommittedSendOutcome(err)) {
      this.settleKeepOpen(ctx);
      this.stampTransferId(err, ctx.transferId);
      return { kind: 'rethrow', error: err };
    }
    if (classifyError(err) === 'conflict') {
      // Nothing was delivered after all (E.2 pure lost race): soft-abort and
      // fall back to the clean-conflict path.
      await this.softAbort(ctx.transferId);
      this.settleFailure(ctx.transferId, ctx.coinId, ctx.sourceIds);
      const demoted = await this.demoteSpentSources(ctx);
      return demoted > 0 ? { kind: 'retry-full', error: err } : { kind: 'rethrow', error: err };
    }
    return { kind: 'rethrow', error: err };
  }

  private async planAndMaterialize(recipientPubkey: string, request: SendRequest, run: SendRun): Promise<AttemptCtx> {
    const transferId = this.newId();
    run.lastTransferId = transferId;
    const planned = this.queue.plan(transferId, { coinId: request.coinId, amount: request.amount });
    const spend = planned.kind === 'planned' ? planned.spend : await planned.settled;
    const sourceIds = this.markPlanned(transferId, request.coinId, spend);
    try {
      return await this.materialize(transferId, recipientPubkey, request, spend, sourceIds);
    } catch (err) {
      this.settleFailure(transferId, request.coinId, sourceIds);
      throw err;
    }
  }

  /** Reserve happened synchronously inside queue.plan; mark + declare with no await between. */
  private markPlanned(transferId: string, coinId: string, spend: PlannedSpend): string[] {
    const sourceIds = [
      ...spend.plan.direct,
      ...(spend.plan.split !== undefined ? [spend.plan.split.tokenId] : []),
    ];
    for (const tokenId of sourceIds) this.view.markInFlight(tokenId);
    if (spend.plan.split !== undefined) {
      this.queue.declareExpectedChange(transferId, coinId, spend.plan.split.remainderAmount);
    }
    return sourceIds;
  }

  private async materialize(
    transferId: string,
    recipientPubkey: string,
    request: SendRequest,
    spend: PlannedSpend,
    sourceIds: readonly string[]
  ): Promise<AttemptCtx> {
    const engine = this.engine();
    const blobs = await takeSourceBlobs(this.warmDeps(), sourceIds);
    const sources = new Map<string, SphereToken>();
    const sourceTokens: Token[] = [];
    const spentStates: Record<string, { local: string; protocol: string }> = {};
    for (const tokenId of sourceIds) {
      const bytes = blobs.get(tokenId);
      if (bytes === undefined) {
        throw new SphereError(`Selected source ${tokenId} has no blob in storage`, 'STORAGE_ERROR');
      }
      const token = await engine.decodeToken({ v: TOKEN_BLOB_VERSION, network: 0, tokenId, token: bytes });
      const keys = await engine.deliveryKeys(bytes);
      // local === protocol by construction; the dual field is wire compat (types.ts).
      spentStates[tokenId] = { local: keys.stateHash, protocol: keys.stateHash };
      sources.set(tokenId, token);
      sourceTokens.push(transferringToken(tokenId, request.coinId, engine.balanceOf(token, request.coinId), this.deps.registry, this.nowMs()));
    }
    const payload = buildPayload(recipientPubkey, request, spend, spentStates);
    const plan: MachinePlan = {
      transferId,
      recipientPubkey,
      payload,
      ops: buildOps(payload),
      sources,
      ...(request.memo !== undefined ? { memo: request.memo } : {}),
    };
    return { transferId, coinId: request.coinId, plan, sourceIds, sourceTokens };
  }

  /** isSpent sweep over the attempt's sources; demote proven-spent states (durable). */
  private async demoteSpentSources(ctx: AttemptCtx): Promise<number> {
    const engine = this.engine();
    let demoted = 0;
    for (const [tokenId, token] of ctx.plan.sources) {
      const state = ctx.plan.payload.spentStates?.[tokenId];
      if (state === undefined) continue;
      try {
        if (await engine.isSpent(token)) {
          await this.view.demote(tokenId, state.protocol);
          demoted += 1;
        }
      } catch {
        // Probe outage: never demote on a guess — the attempt budget bounds us.
      }
    }
    return demoted;
  }

  // ── attempt settlement (reservation / in-flight / expected-change hygiene) ─

  private settleSuccess(ctx: AttemptCtx, spentIds: readonly string[]): void {
    this.ledger.commit(ctx.transferId);
    this.queue.clearExpectedChange(ctx.transferId);
    this.trackTail(this.refreshThenRelease(ctx.coinId, spentIds));
  }

  private settleFailure(transferId: string, coinId: string, releaseIds: readonly string[]): void {
    this.ledger.cancel(transferId);
    this.queue.clearExpectedChange(transferId);
    for (const tokenId of releaseIds) this.view.release(tokenId);
    this.queue.notifyChange(coinId);
  }

  /** Open intent: sources stay reserved + in-flight (§5.2) until resume adopts them. */
  private settleKeepOpen(ctx: AttemptCtx): void {
    this.queue.clearExpectedChange(ctx.transferId);
    // The reservation is now the intent's pin, and lives and dies with it (#737).
    this.pins.adopt(ctx.transferId);
    this.heartbeat.arm(); // the parked intent converges in-session — no restart
  }

  private settlePartial(ctx: AttemptCtx, partial: ShortfallEntry): void {
    this.ledger.cancel(ctx.transferId);
    this.queue.clearExpectedChange(ctx.transferId);
    const committed = new Set(partial.committedTokenIds);
    for (const tokenId of ctx.sourceIds) {
      if (committed.has(tokenId)) continue;
      // The conflicted leg's source is proven foreign-spent — demote + release.
      const state = ctx.plan.payload.spentStates?.[tokenId];
      if (state !== undefined) this.trackTail(this.view.demote(tokenId, state.protocol));
      this.view.release(tokenId);
    }
    this.trackTail(this.refreshThenRelease(ctx.coinId, [...committed]));
  }

  /** Release spent sources only AFTER the mirror refresh tombstoned them. */
  private async refreshThenRelease(coinId: string, spentIds: readonly string[]): Promise<void> {
    try {
      await this.view.delta();
      for (const tokenId of spentIds) this.view.release(tokenId);
    } finally {
      this.queue.notifyChange(coinId);
    }
  }

  private accumulate(ctx: AttemptCtx, committedIds: readonly string[], run: SendRun): void {
    const committed = new Set(committedIds);
    for (const op of ctx.plan.ops) {
      if (!committed.has(op.sourceTokenId)) continue;
      run.tokenTransfers.push({ sourceTokenId: op.sourceTokenId, method: op.kind });
    }
    for (const token of ctx.sourceTokens) {
      if (committed.has(token.id)) run.sentTokens.push(token);
    }
  }

  private async finishSend(transferId: string, run: SendRun): Promise<TransferResult> {
    for (const id of run.settledShortfalls.splice(0)) {
      await this.machineStores.shortfalls.removeByKey(id).catch(() => undefined);
    }
    if (run.pendingAny) this.heartbeat.arm(); // deposits owed in the journal — heartbeat work
    const result: TransferResult = {
      id: transferId,
      status: run.pendingAny ? 'confirmed' : 'delivered',
      tokens: [...run.sentTokens],
      tokenTransfers: [...run.tokenTransfers],
      deliveryPending: run.pendingAny,
      deliveryState: run.pendingAny ? 'pending-delivery' : 'landed',
    };
    this.deps.emit('transfer:updated', result);
    return result;
  }

  /** Nothing delivered → UNWRAPPED; after ≥1 delivered leg every failure surfaces as PartialSendConflictError over the settled set. */
  private partialize(err: unknown, run: SendRun): unknown {
    if (run.delivered.length === 0) return err;
    return new PartialSendConflictError(
      'Part of your payment was sent; the remaining amount could not be completed (see cause). The delivered portion is final — re-plan only the shortfall, never the full amount.',
      run.firstPartialId ?? '',
      run.delivered,
      run.amount,
      err
    );
  }

  /** #441: possibly-committed errors must carry the transferId for the settling journal. */
  private stampTransferId(err: unknown, transferId: string): void {
    if (err instanceof SphereError && isPossiblyCommittedSendOutcome(err) && err.transferId === undefined) {
      err.transferId = transferId;
    }
  }

  private async softAbort(transferId: string): Promise<void> {
    try {
      await this.deps.client.abortIntent(transferId);
      await this.machineStores.backstop.removeByKey(transferId);
    } catch {
      // Stays locally recorded; the #676 resume gate converges it later.
    }
  }

  // ── mint (§5.9: journal-first, replayed at start, never blind re-mint) ─────

  private async mintInner(coinId: string, amount: bigint): Promise<MintResult> {
    if (!/^(?:[0-9a-f]{2})+$/.test(coinId) || amount <= 0n) {
      return { success: false, error: 'coinId must be even-length lowercase hex and amount positive' };
    }
    const mintId = this.newId();
    this.activeMoneyOps.add(mintId); // its replay stays hands-off while this attempt runs
    try {
      return await this.mintUnderJournal(mintId, coinId, amount);
    } finally {
      this.activeMoneyOps.delete(mintId);
    }
  }

  private async mintUnderJournal(mintId: string, coinId: string, amount: bigint): Promise<MintResult> {
    const engine = this.engine();
    // tokenId stays '' until mint returns; replay converges via the F13 same-seed re-call.
    const entry: MintJournalEntry = {
      mintId,
      coinId,
      amount: amount.toString(),
      tokenId: '',
      createdAt: this.nowMs(),
    };
    await this.machineStores.mintJournal.upsert(entry);
    let token: SphereToken;
    try {
      token = await engine.mint(mintParams(this.ownPubkeyBytes, coinId, amount), { transferId: mintId });
    } catch (err) {
      // Entry retained: the heartbeat / start() replay resolves it (inventory check / F13 seed).
      this.heartbeat.arm();
      return { success: false, error: messageOf(err) };
    }
    if (token.blob.tokenId !== entry.tokenId) {
      await this.machineStores.mintJournal.upsert({ ...entry, tokenId: token.blob.tokenId });
    }
    try {
      await this.finalizeMint(engine, mintId, token, coinId, amount.toString());
    } catch (err) {
      this.heartbeat.arm();
      return { success: false, tokenId: token.blob.tokenId, error: messageOf(err) };
    }
    return { success: true, tokenId: token.blob.tokenId };
  }

  private async finalizeMint(
    engine: ITokenEngine,
    mintId: string,
    token: SphereToken,
    coinId: string,
    amount: string
  ): Promise<void> {
    const bytes = token.blob.token;
    const digest = bytesToHex(sha256(bytes));
    const keys = await this.deps.storagePort.uploadBlobs([{ sha256: digest, bytes }]);
    const key = keys.get(digest);
    if (key === undefined) {
      throw new SphereError(`no upload key returned for mint blob ${digest}`, 'STORAGE_ERROR');
    }
    await this.deps.storagePort.applyDelta({
      transferId: mintId,
      spent: [],
      added: [{ tokenId: token.blob.tokenId, key }],
    });
    await this.historyStore.recordMint({ tokenId: token.blob.tokenId, coinId, amount });
    await this.machineStores.mintJournal.removeByKey(mintId);
    this.heldStates.set(token.blob.tokenId, (await engine.deliveryKeys(bytes)).stateHash);
    this.trackTail(this.view.delta());
  }

  /** @returns how many journal entries were RESOLVED (cleared) — heartbeat progress. */
  private async replayMints(): Promise<number> {
    let resolved = 0;
    for (const entry of await this.machineStores.mintJournal.list()) {
      if (this.activeMoneyOps.has(entry.mintId)) continue; // its mintInner still owns it
      try {
        if (await this.replayMint(entry)) resolved += 1;
      } catch {
        // Entry retained — replayed again at the next pass / start().
      }
    }
    return resolved;
  }

  private async replayMint(entry: MintJournalEntry): Promise<boolean> {
    if (entry.tokenId !== '' && (await this.tokenInServerInventory(entry.tokenId))) {
      await this.machineStores.mintJournal.removeByKey(entry.mintId);
      return true;
    }
    const engine = this.engine();
    if (!supportsDeterministicMint(engine)) {
      // Without the F13 seed a re-mint would create a SECOND token: hold + alert.
      this.deps.emit('transfer:attention', {
        transferId: entry.mintId,
        code: ATTENTION_MINT_UNRESOLVED,
      });
      return false; // held, not resolved — never counts as heartbeat progress
    }
    const token = await engine.mint(mintParams(this.ownPubkeyBytes, entry.coinId, BigInt(entry.amount)), {
      transferId: entry.mintId,
    });
    if (token.blob.tokenId !== entry.tokenId) {
      await this.machineStores.mintJournal.upsert({ ...entry, tokenId: token.blob.tokenId });
    }
    await this.finalizeMint(engine, entry.mintId, token, entry.coinId, entry.amount);
    return true;
  }

  private async tokenInServerInventory(tokenId: string): Promise<boolean> {
    let page = await this.deps.storagePort.listInventory();
    for (let i = 0; i < INVENTORY_SCAN_PAGE_LIMIT; i++) {
      if (page.items.some((item) => item.tokenId === tokenId && item.status === 'active')) {
        return true;
      }
      if (!page.more) return false;
      page = await this.deps.storagePort.listInventory(page.cursor);
    }
    return false;
  }

  // ── wiring internals ───────────────────────────────────────────────────────

  private engine(): ITokenEngine {
    return this.currentEngine ?? this.deps.engineRef();
  }

  private newId(): string {
    return (this.deps.newId ?? randomUUID)();
  }

  private async seedHeldStates(): Promise<void> {
    let page = await this.deps.storagePort.listInventory();
    for (let i = 0; i < INVENTORY_SCAN_PAGE_LIMIT; i++) {
      for (const item of page.items) {
        if (item.status === 'active') this.heldStates.set(item.tokenId, item.stateHash);
      }
      if (!page.more) return;
      page = await this.deps.storagePort.listInventory(page.cursor);
    }
  }

  private track<T>(op: Promise<T>): Promise<T> {
    const settled = op.then(() => undefined, () => undefined);
    this.pendingOps.add(settled);
    void settled.finally(() => this.pendingOps.delete(settled));
    return op;
  }

  private trackTail(op: Promise<unknown>): void {
    this.track(op).catch(() => undefined);
  }
}

