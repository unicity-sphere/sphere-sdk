// §7 in-session convergence: the heartbeat timing cell (in-memory timer +
// backoff value ONLY), the single convergence pass, and the §4
// pendingTransfers() on-read derivation. The facade owns lifecycle,
// the resume single-flight, and the active-op ownership registry.

import type { PendingTransfer } from './api';
import type { DeliveryPort } from './ports';
import type { DeliveryJournalEntry, IntentBackstopEntry, ShortfallEntry } from './stores';
import type { IntentPayload } from './machine/types';
import { retryAfterMsOf, type MachineStores, type ReplayDeps } from './machine/journal';
import { resumeAll } from './machine/resume';
import type { MachineDeps } from './machine/TransferMachine';

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

export interface ConvergerDeps {
  machineDeps: MachineDeps;
  stores: MachineStores;
  delivery: DeliveryPort;
  reconcile(report: { resumed: string[]; conflicted: string[]; open: string[] }): Promise<void>;
  refreshView(): Promise<void>;
  replayMints(): Promise<number>;
  /** §7 ownership: the pass never adopts an op whose machine runs in-process. */
  isActiveOp(id: string): boolean;
  emit(event: string, payload: unknown): void;
  now(): number;
}

export class Converger {
  constructor(private readonly deps: ConvergerDeps) {}

  /** Resume open intents, then drain the delivery + mint journals (all idempotent). */
  async convergeOnce(): Promise<ConvergeOutcome> {
    let progress = false;
    let retryAfterMs: number | null = null;
    try {
      progress = await this.resumePass();
    } catch (err) {
      retryAfterMs = retryAfterMsOf(err);
    }
    try {
      const stats = await this.deps.stores.deliveryJournal.replay(this.replayDeps());
      progress = progress || stats.delivered > 0;
    } catch (err) {
      retryAfterMs ??= retryAfterMsOf(err);
    }
    try {
      progress = (await this.deps.replayMints()) > 0 || progress;
    } catch (err) {
      retryAfterMs ??= retryAfterMsOf(err);
    }
    return { progress, retryAfterMs };
  }

  /** §4 heartbeat predicate — read fresh from the §6 stores, never cached. */
  async pendingWork(): Promise<boolean> {
    const [backstop, journal, mints] = await Promise.all([
      this.deps.stores.backstop.list(),
      this.deps.stores.deliveryJournal.list(),
      this.deps.stores.mintJournal.list(),
    ]);
    return backstop.length > 0 || journal.some((e) => e.undeliverable !== true) || mints.length > 0;
  }

  private async resumePass(): Promise<boolean> {
    const report = await resumeAll(this.filteredMachineDeps(), {
      isLocallyActive: (id) => this.deps.isActiveOp(id),
    });
    const progress = report.resumed.length > 0 || report.conflicted.length > 0;
    await this.deps.reconcile({
      resumed: report.resumed,
      conflicted: report.conflicted,
      open: report.failed,
    });
    if (progress) await this.deps.refreshView().catch(() => undefined);
    return progress;
  }

  private filteredMachineDeps(): MachineDeps {
    const intents = this.deps.machineDeps.intents;
    return {
      ...this.deps.machineDeps,
      intents: {
        ...intents,
        listOpen: async () =>
          (await intents.listOpen()).filter((intent) => !this.deps.isActiveOp(intent.transferId)),
      },
    };
  }

  private replayDeps(): ReplayDeps {
    return {
      delivery: this.deps.delivery,
      now: () => this.deps.now(),
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
  for (const entry of shortfalls) {
    if (!seen.has(entry.transferId)) out.push(shortfallRow(entry));
  }
  return out;
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
    coinId: typeof payload?.coinId === 'string' ? payload.coinId : '',
    amount: typeof payload?.amount === 'string' ? payload.amount : '',
    legs: { certified, total: Math.max(total, certified) },
    deliveryPending: journal.length > 0,
    createdAt: entry.createdAt,
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
