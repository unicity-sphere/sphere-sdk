/**
 * LoadDeltaTracker (Tasks 6.4 + 4.2, DESIGN §5.4) — the anti-rollback gate.
 *
 * The provider's `load()` paginates `/state?since=` and feeds each page here. The
 * tracker:
 *  1. CURSOR MONOTONICITY (6.4): the reported `cursor` must never regress below
 *     the `since` it answered — a regression with no sanctioned epoch is a
 *     rollback.
 *  2. SIGNED-ROOT COMPARISON (4.2): the wallet persists a signed baseline
 *     `{cursor, root, sig}` after each clean flush/load. On the next load the
 *     tracker folds the `/state` delta into the baseline accumulator and recomputes
 *     the root. Because the wallet is the ONLY writer, any non-empty delta it did
 *     NOT itself author (no intervening flush advanced the baseline) yields a root
 *     that diverges from the signed baseline root → rollback. The mismatch surfaces
 *     as `storage:error{reason:'rollback'}` in the provider (the FROZEN union is
 *     untouched — there is no `storage:rollback` member).
 *  3. EPOCH SHORT-CIRCUIT SEAM (Task 8.2): a `/state` `epochSig` that verifies under
 *     `NETWORKS[net].vaultServerKey` AND advances the epoch is a SANCTIONED reset —
 *     it re-baselines instead of alarming. Here we only RECOGNISE a verified bump
 *     so the gate does not false-alarm on a real reset; the full drop+re-baseline
 *     behaviour is completed in 8.2. With no verified bump, any regression / root
 *     divergence alarms.
 */

import { computeRoot, foldDelta, signRoot, verifyRoot } from './merkle';
import type { EntryState } from './merkle';
import { epochCanon } from '../../vault-aead/canon';
import { verifySignedMessage } from '../../core/crypto';
import type { StateEntry } from './types';

/** Minimal local KV the signed baseline persists into (injected in tests). */
export interface LocalBaselineStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** The wallet-signed baseline `{cursor, root, sig, epoch}` for one owner. */
interface SignedBaseline {
  cursor: number;
  root: string;
  sig: string;
  epoch: number;
}

export interface LoadDeltaConfig {
  network: string;
  /** Compressed server signing key (`NETWORKS[net].vaultServerKey`) for epoch verify. */
  vaultServerKey?: string;
  baseline?: LocalBaselineStore;
}

/** One `/state` page handed to the tracker. */
export interface LoadPage {
  since: number;
  entries: StateEntry[];
  cursor: number;
  epoch: number;
  epochSig: string;
}

/** Gate verdict for one page. */
export type GateResult = { ok: true } | { ok: false; reason: string };

export class LoadDeltaTracker {
  private readonly config: LoadDeltaConfig;
  private ownerId = '';
  private walletPriv = '';

  /** The accumulator state for THIS load pass (rebuilt from the signed baseline). */
  private accState: Map<string, EntryState> | null = null;
  /** The signed baseline loaded at the start of this pass (null = first ever load). */
  private baseline: SignedBaseline | null = null;

  constructor(config: LoadDeltaConfig) {
    this.config = config;
  }

  setIdentity(ownerId: string): void {
    this.ownerId = ownerId;
  }

  /** The wallet private key, needed to (re)sign the baseline root. */
  setWalletPriv(priv: string): void {
    this.walletPriv = priv;
  }

  /**
   * Begin a load pass: load + verify the persisted signed baseline and seed the
   * accumulator from the provider's authoritative `known` state (what it believes
   * the server holds). MUST be called once before the pagination loop.
   *
   * Seeding from `known` is what makes the root gate precise: the wallet is the
   * ONLY writer, so a clean re-load returns an EMPTY delta and the accumulator
   * (= known) recomputes to the signed baseline root. A NON-empty delta the
   * wallet did not author (mutation / injection) shifts the root away from the
   * signed baseline → rollback.
   */
  async beginLoad(known: Map<string, EntryState>): Promise<void> {
    this.baseline = await this.loadBaseline();
    this.accState = new Map(known);
    if (this.baseline && !verifyRoot(this.bindingFor(this.baseline.cursor, this.baseline.root), this.baseline.sig, this.ownerPubForVerify())) {
      // A corrupt/forged local baseline is treated as no baseline (a fresh load).
      this.baseline = null;
    }
  }

  /** Ingest one `/state` page: monotonicity + root gate. */
  async ingestPage(page: LoadPage): Promise<GateResult> {
    if (this.accState === null) await this.beginLoad(new Map());
    const epochOk = this.recogniseEpoch(page);
    const mono = this.checkMonotonic(page);
    if (!mono.ok && !epochOk) return mono;
    this.fold(page.entries);
    if (this.baseline && !epochOk) {
      const verdict = this.checkRoot();
      if (!verdict.ok) return verdict;
    }
    return { ok: true };
  }

  /** Recognise a server-verified epoch bump (sanctioned reset — 8.2 seam). */
  private recogniseEpoch(page: LoadPage): boolean {
    if (!this.config.vaultServerKey) return false;
    const baseEpoch = this.baseline?.epoch ?? 0;
    if (page.epoch <= baseEpoch) return false;
    const canon = epochCanon(this.config.network, page.epoch);
    return verifySignedMessage(canon, page.epochSig, this.config.vaultServerKey);
  }

  /** Cursor must be non-decreasing relative to the `since` it answered. */
  private checkMonotonic(page: LoadPage): GateResult {
    if (page.cursor < page.since) {
      return { ok: false, reason: `cursor regressed: ${page.cursor} < since ${page.since}` };
    }
    return { ok: true };
  }

  private fold(entries: StateEntry[]): void {
    const delta = new Map<string, EntryState>();
    for (const e of entries) delta.set(e.key, { version: e.version, deleted: e.deleted });
    const { state } = foldDelta(this.accState!, delta);
    this.accState = state;
  }

  /**
   * The folded root must equal the signed baseline root: the wallet is the only
   * writer, so a delta it did not author (no intervening flush advanced the
   * baseline) means the server injected state — a rollback.
   */
  private checkRoot(): GateResult {
    const folded = computeRoot(this.accState!);
    if (folded !== this.baseline!.root) {
      return { ok: false, reason: 'rollback' };
    }
    return { ok: true };
  }

  /**
   * Persist a fresh signed baseline after a clean load. `known` is the provider's
   * authoritative post-load state; the root binds `(network, ownerId, cursor)`.
   */
  async commitBaseline(cursor: number, epoch: number, _epochSig: string): Promise<void> {
    if (this.config.baseline && this.walletPriv) {
      const root = computeRoot(this.accState ?? new Map());
      const sig = signRoot(this.walletPriv, this.bindingFor(cursor, root));
      const baseline: SignedBaseline = { cursor, root, sig, epoch };
      await this.config.baseline.set(this.baselineKey(), JSON.stringify(baseline));
    }
    this.accState = null; // close the pass regardless of whether a baseline was persisted
  }

  private async loadBaseline(): Promise<SignedBaseline | null> {
    if (!this.config.baseline) return null;
    const raw = await this.config.baseline.get(this.baselineKey());
    return raw ? (JSON.parse(raw) as SignedBaseline) : null;
  }

  private bindingFor(cursor: number, root: string): { network: string; ownerId: string; cursor: number; root: string } {
    return { network: this.config.network, ownerId: this.ownerId, cursor, root };
  }

  /** The signed root is verified against the wallet's OWN pubkey (it self-signs). */
  private ownerPubForVerify(): string {
    return this.ownerId;
  }

  private baselineKey(): string {
    return `vault_baseline:${this.config.network}:${this.ownerId}`;
  }
}
