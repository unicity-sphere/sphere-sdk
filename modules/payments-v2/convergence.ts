// §7 in-session convergence: the heartbeat timing cell (in-memory timer +
// backoff value ONLY), the single convergence pass, and the §4
// pendingTransfers() on-read derivation. The facade owns lifecycle,
// the resume single-flight, and the active-op ownership registry.

import type { PendingTransfer } from './api';
import type { DeliveryPort } from './ports';
import { isLiveBurn, type DeliveryJournalEntry, type IntentBackstopEntry, type ShortfallEntry } from './stores';
import type { CoinIntentPayload, IntentPayload } from './machine/types';
import { retryAfterMsOf, type MachineStores, type ReplayDeps } from './machine/journal';
import { resumeAll, validatePayload } from './machine/resume';
import { repostKept } from './machine/settled-history';
import type { IntentApi, MachineDeps } from './machine/TransferMachine';

// Backoff: seed 5 s, ×2 per unproductive pass, cap 120 s; reset on progress
// and on connection recovery; a surfaced Retry-After floors the next pass.
export const HEARTBEAT_SEED_MS = 5_000;
export const HEARTBEAT_CAP_MS = 120_000;

export interface ConvergeOutcome {
  progress: boolean;
  retryAfterMs: number | null;
}

interface HeartbeatDeps {
  now: () => number;
  onTick: () => void;
}

export class ConvergenceHeartbeat {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delayMs = HEARTBEAT_SEED_MS;
  private notBefore = 0;
  private running = false;

  constructor(private readonly deps: HeartbeatDeps) {}

  start(): void {
    this.running = true;
    this.delayMs = HEARTBEAT_SEED_MS;
    this.notBefore = 0;
  }

  /** §7 quiescence unchanged: a mid-backoff stop() cancels cleanly. */
  stop(): void {
    this.running = false;
    this.clearTimer();
  }

  /** Reset to seed on progress, ×2 to the cap otherwise; idle stops rescheduling. */
  settle(outcome: ConvergeOutcome, pending: boolean): void {
    if (outcome.retryAfterMs !== null) {
      this.notBefore = Math.max(this.notBefore, this.deps.now() + outcome.retryAfterMs);
    }
    if (!pending) {
      // Never clearTimer here: an arm() for work that appeared AFTER this
      // pass read the pending set must survive the pass's idle settle — the
      // armed tick re-reads the stores and idles itself if truly quiescent.
      this.delayMs = HEARTBEAT_SEED_MS;
      return;
    }
    const delay = outcome.progress ? HEARTBEAT_SEED_MS : this.delayMs;
    this.delayMs = Math.min(delay * 2, HEARTBEAT_CAP_MS);
    this.schedule(delay);
  }

  /** New pending work (keep-open park / journaled delivery / mint hold): prompt retry. */
  arm(): void {
    if (!this.running) return;
    this.delayMs = Math.min(HEARTBEAT_SEED_MS * 2, HEARTBEAT_CAP_MS);
    this.schedule(HEARTBEAT_SEED_MS);
  }

  /** connection:status recovery: the backoff resets; a pending tick re-fires at the seed. */
  recovered(): void {
    this.delayMs = HEARTBEAT_SEED_MS;
    if (this.timer !== null) this.arm();
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    if (!this.running) return;
    const floored = Math.max(delayMs, this.notBefore - this.deps.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.deps.onTick();
    }, floored);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * §7 ownership: the ids with an in-process money op. #835: a running pass watches it, so
 * every id in process at any moment of that pass — already running when it began, or
 * started while it runs — stays the process's own until the pass ends.
 */
export class ActiveOps {
  private readonly ids = new Set<string>();
  private readonly passes = new Set<Set<string>>();

  add(id: string): void {
    this.ids.add(id);
    for (const seen of this.passes) seen.add(id);
  }

  delete(id: string): void {
    this.ids.delete(id);
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** Records into `seen` every id in process now and every one started until the stop is called. */
  watch(seen: Set<string>): () => void {
    for (const id of this.ids) seen.add(id);
    this.passes.add(seen);
    return () => {
      this.passes.delete(seen);
    };
  }
}

export interface ConvergerDeps {
  machineDeps: MachineDeps;
  stores: MachineStores;
  delivery: DeliveryPort;
  reconcile(report: { resumed: string[]; conflicted: string[]; open: string[] }): Promise<void>;
  refreshView(): Promise<void>;
  replayMints(): Promise<number>;
  replayNftMints(): Promise<number>;
  replayCustomMints(): Promise<number>;
  replayBurns(): Promise<number>;
  /** §7 ownership: the pass never adopts an op whose machine runs in-process. */
  readonly activeOps: ActiveOps;
  /** #835: the sends this process parked — held even when their 'unconfirmed' flag write failed. */
  readonly parked: Set<string>;
  emit(event: string, payload: unknown): void;
  now(): number;
}

export class Converger {
  private readonly reposting = new Set<string>();

  constructor(private readonly deps: ConvergerDeps) {}

  /** Resume open intents, then drain the delivery + mint journals (all idempotent). */
  async convergeOnce(): Promise<ConvergeOutcome> {
    let progress = false;
    let retryAfterMs: number | null = null;
    const wait = (ms: number | null): void => {
      if (ms !== null) retryAfterMs = Math.max(retryAfterMs ?? 0, ms); // the longest any phase was asked
    };
    try {
      const pass = await this.resumePass();
      progress = pass.progress;
      wait(pass.retryAfterMs);
    } catch (err) {
      wait(retryAfterMsOf(err));
    }
    try {
      const stats = await this.deps.stores.deliveryJournal.replay(this.replayDeps());
      progress = progress || stats.delivered > 0;
    } catch (err) {
      wait(retryAfterMsOf(err));
    }
    // Caught apart: an unreadable coin journal must not starve the NFT one.
    for (const replay of [
      () => this.deps.replayMints(),
      () => this.deps.replayNftMints(),
      () => this.deps.replayCustomMints(),
      () => this.deps.replayBurns(),
    ]) {
      try {
        progress = (await replay()) > 0 || progress;
      } catch (err) {
        wait(retryAfterMsOf(err));
      }
    }
    this.repostSentOutbox();
    return { progress, retryAfterMs };
  }

  /** #842: off the pass, so a history POST that never answers holds no convergence. */
  private repostSentOutbox(): void {
    const { machineDeps, stores, activeOps } = this.deps;
    const inFlight = machineDeps.sentInFlight ?? this.reposting;
    const recordHistory = machineDeps.recordHistory;
    if (recordHistory === undefined) return;
    const deps = {
      recordHistory,
      whileLive: machineDeps.whileLive,
      outbox: stores.sentOutbox,
      readPayload: async (envelope: string) => validatePayload(await machineDeps.decryptPayload(envelope)),
    };
    void stores.sentOutbox.list().then((entries) => {
      for (const entry of entries) {
        const { transferId } = entry;
        // An attempt in process posts its own record; one POST per record at a time, whoever issued it.
        if (activeOps.has(transferId) || inFlight.has(transferId)) continue;
        inFlight.add(transferId);
        void repostKept(deps, entry).finally(() => inFlight.delete(transferId));
      }
    }, () => undefined);
  }

  /** §4 heartbeat predicate — read fresh from the §6 stores, never cached. */
  async pendingWork(): Promise<boolean> {
    const [backstop, journal, mints, nftMints, customMints, burns, sentOutbox] = await Promise.all([
      this.deps.stores.backstop.list(),
      this.deps.stores.deliveryJournal.list(),
      this.deps.stores.mintJournal.list(),
      this.deps.stores.nftMintJournal.list(),
      this.deps.stores.customMintJournal.list(),
      this.deps.stores.burnJournal.list(),
      this.deps.stores.sentOutbox.list(),
    ]);
    const mintsOpen = mints.length > 0 || nftMints.length > 0 || customMints.length > 0;
    const burnsOpen = burns.some(isLiveBurn);
    // #842: an unacknowledged SENT record is work too — only a pass re-posts it.
    const historyOwed = sentOutbox.length > 0;
    return backstop.length > 0 || journal.some((e) => e.undeliverable !== true) || mintsOpen || burnsOpen || historyOwed;
  }

  private async resumePass(): Promise<ConvergeOutcome> {
    let deferred = false;
    // #835: activity is judged ONCE per pass — an id in process at ANY moment of the pass is
    // the process's own for all of it, even when its attempt ends before the pass reaches
    // its entry, or started after the listing was computed (so is not in it).
    const inPass = new Set<string>();
    const stopWatching = this.deps.activeOps.watch(inPass);
    const report = await resumeAll(this.filteredMachineDeps(inPass), {
      isLocallyActive: (id) => inPass.has(id),
      isParked: (id) => this.deps.parked.has(id),
      onHoldEnded: (id) => this.deps.parked.delete(id),
      onDeferred: () => {
        deferred = true;
      },
    }).finally(stopWatching);
    // #835: an unreadable backstop proves nothing — reconciling its empty report would
    // resolve a held payment link 'paid' through the unaccounted branch.
    if (deferred) return { progress: false, retryAfterMs: null };
    const progress = report.resumed.length > 0 || report.conflicted.length > 0;
    // #835: a link written while the pass ran is in none of its sets. Anything with a local
    // entry NOW (held, parked, being cancelled, or an attempt that ended mid-pass) can still
    // run or abort, so it is open — never "unaccounted", which resolves the link paid. An
    // unreadable backstop skips only the reconcile, never the pass's progress.
    const local = await this.deps.stores.backstop.list().then(
      (entries) => entries.map((entry) => entry.transferId),
      () => null
    );
    if (local !== null) {
      await this.deps.reconcile({
        resumed: report.resumed,
        conflicted: report.conflicted,
        open: [...report.failed, ...local],
      });
    }
    if (progress) await this.deps.refreshView().catch(() => undefined);
    return { progress, retryAfterMs: report.retryAfterMs ?? null };
  }

  private filteredMachineDeps(inPass: ReadonlySet<string>): MachineDeps {
    const intents = this.deps.machineDeps.intents;
    const listOpen: IntentApi['listOpen'] = async () =>
      (await intents.listOpen()).filter((intent) => !inPass.has(intent.transferId));
    return { ...this.deps.machineDeps, intents: { ...intents, listOpen } };
  }

  private replayDeps(): ReplayDeps {
    return {
      delivery: this.deps.delivery,
      now: () => this.deps.now(),
      // sphere#487: a replayed leg carries the sender's name too — the machine
      // deps hold the one live getter, so replay can never drift from a send.
      ...(this.deps.machineDeps.ownNametag !== undefined
        ? { ownNametag: this.deps.machineDeps.ownNametag }
        : {}),
      attention: (transferId, code, detail) => {
        this.deps.emit(
          'transfer:attention',
          detail === undefined ? { transferId, code } : { transferId, code, detail }
        );
      },
    };
  }
}

/** §4 pendingTransfers(): derived ON READ from the §6 stores — never cached. */
export async function derivePendingTransfers(
  stores: MachineStores,
  decryptPayload: (envelope: string) => Promise<unknown>
): Promise<PendingTransfer[]> {
  const [backstop, journal, shortfalls] = await Promise.all([
    stores.backstop.list(),
    stores.deliveryJournal.list(),
    stores.shortfalls.list(),
  ]);
  const byTransfer = groupJournal(journal);
  const out: PendingTransfer[] = [];
  const seen = new Set<string>();
  for (const entry of backstop) {
    // abortPending/aborted rows are rollbacks in convergence, not user-visible sends.
    if (entry.disposition !== 'open') continue;
    seen.add(entry.transferId);
    out.push(await openRow(entry, byTransfer.get(entry.transferId) ?? [], decryptPayload));
  }
  for (const [transferId, entries] of byTransfer) {
    if (seen.has(transferId)) continue;
    seen.add(transferId);
    out.push(journalOnlyRow(transferId, entries));
  }
  // #835: a row a later attempt holds is listed as that attempt's open row, never as owed.
  const held = new Set(backstop.flatMap((entry) => (entry.owes ?? []).map((row) => row.transferId)));
  for (const entry of shortfalls) {
    if (!seen.has(entry.transferId) && !held.has(entry.transferId)) out.push(shortfallRow(entry));
  }
  return out;
}

/**
 * #737: the source tokenIds each still-open intent pins, derived ON READ from the
 * same §6 backstop `derivePendingTransfers` reads — the pin needs no store of its
 * own, so a restart re-derives it instead of re-offering the tokens as spendable.
 */
export async function deriveOpenIntentHolds(
  stores: MachineStores,
  decryptPayload: (envelope: string) => Promise<unknown>
): Promise<{ open: Map<string, string[]>; complete: boolean }> {
  const holds = new Map<string, string[]>();
  let complete = true;
  for (const entry of await stores.backstop.list()) {
    if (entry.disposition !== 'open') continue;
    let payload: Partial<IntentPayload> | null = null;
    try {
      const raw = await decryptPayload(entry.payloadEnvelope);
      if (raw !== null && typeof raw === 'object') payload = raw as Partial<IntentPayload>;
    } catch {
      // Undecodable envelope on a STILL-OPEN intent: its sources are unknown, so
      // they cannot be proven safe. Report incompleteness — the caller fails
      // closed rather than treating "unknown sources" as "no sources" (#738).
      complete = false;
      continue;
    }
    if (payload === null) {
      complete = false;
      continue;
    }
    const direct = Array.isArray(payload?.direct) ? payload.direct.filter((id) => typeof id === 'string') : [];
    const split = typeof payload?.split?.tokenId === 'string' ? [payload.split.tokenId] : [];
    holds.set(entry.transferId, [...direct, ...split]);
  }
  for (const burn of await stores.burnJournal.list()) {
    if (isLiveBurn(burn)) holds.set(burn.burnId, [burn.tokenId]);
  }
  return { open: holds, complete };
}

function groupJournal(journal: DeliveryJournalEntry[]): Map<string, DeliveryJournalEntry[]> {
  const byTransfer = new Map<string, DeliveryJournalEntry[]>();
  for (const entry of journal) {
    const mine = byTransfer.get(entry.transferId);
    if (mine === undefined) byTransfer.set(entry.transferId, [entry]);
    else mine.push(entry);
  }
  return byTransfer;
}

async function openRow(
  entry: IntentBackstopEntry,
  journal: DeliveryJournalEntry[],
  decryptPayload: (envelope: string) => Promise<unknown>
): Promise<PendingTransfer> {
  let payload: Partial<IntentPayload> | null = null;
  try {
    const raw = await decryptPayload(entry.payloadEnvelope);
    if (raw !== null && typeof raw === 'object') payload = raw as Partial<IntentPayload>;
  } catch {
    payload = null; // undecodable envelope: surface the row, not the fields
  }
  const total = Array.isArray(payload?.direct)
    ? payload.direct.length + (payload.split !== undefined ? 1 : 0)
    : 0;
  const certified = distinctOpCount(journal);
  return {
    transferId: entry.transferId,
    kind: 'open',
    recipient: typeof payload?.recipient === 'string' ? payload.recipient : '',
    ...subject(payload),
    legs: { certified, total: Math.max(total, certified) },
    deliveryPending: journal.length > 0,
    createdAt: entry.createdAt,
  };
}

/**
 * What the row is FOR: a coin and an amount, or the token being moved. A
 * token-addressed intent names no coin, so it renders as its token rather than
 * as `coinId: ''` / `amount: ''`.
 */
function subject(
  payload: Partial<IntentPayload> | null
): { coinId: string; amount: string; tokenId?: string } {
  // Both spellings: this reads the RAW decrypted payload, never normalised by
  // validatePayload, so a 0.17-written intent still says 'coinless'.
  const rawKind = (payload as { kind?: string } | null)?.kind;
  if (rawKind === 'whole' || rawKind === 'coinless') {
    const tokenId = payload?.direct?.[0];
    return { coinId: '', amount: '', ...(typeof tokenId === 'string' ? { tokenId } : {}) };
  }
  const coin = payload as Partial<CoinIntentPayload> | null;
  return {
    coinId: typeof coin?.coinId === 'string' ? coin.coinId : '',
    amount: typeof coin?.amount === 'string' ? coin.amount : '',
  };
}

/** The intent already completed but a deposit is still owed from the journal. */
function journalOnlyRow(transferId: string, entries: DeliveryJournalEntry[]): PendingTransfer {
  const certified = distinctOpCount(entries);
  return {
    transferId,
    kind: 'open',
    recipient: entries[0].recipientPubkey,
    coinId: '',
    amount: '',
    legs: { certified, total: certified },
    deliveryPending: true,
    createdAt: 0,
  };
}

function shortfallRow(entry: ShortfallEntry): PendingTransfer {
  return {
    transferId: entry.transferId,
    kind: 'shortfall',
    recipient: entry.recipient,
    coinId: entry.coinId,
    amount: entry.remainingAmount,
    legs: { certified: entry.committedTokenIds.length, total: entry.committedTokenIds.length },
    deliveryPending: false,
    createdAt: entry.createdAt,
  };
}

function distinctOpCount(entries: readonly DeliveryJournalEntry[]): number {
  return new Set(entries.map((entry) => entry.opIndex)).size;
}
