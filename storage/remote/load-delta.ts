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
  /**
   * The CANONICAL vault network literal (`normalizeVaultNetwork(...)`) — binds the
   * signed-root message and the `epochCanon` the server epochSig is verified over,
   * so a `testnet`-aliased and a `testnet2`-configured wallet share the same root /
   * epoch signing domain.
   */
  network: string;
  /**
   * The LITERAL network name for the local baseline STORAGE key. Storage scoping
   * stays on the literal (migration-v2 trap), NOT the canonical literal — keep it
   * distinct from {@link LoadDeltaConfig.network}. Defaults to `network` when omitted.
   */
  storageNetwork?: string;
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

/**
 * Gate verdict for one page. `reset` is set on the `ok` branch when a SANCTIONED
 * epoch reset was recognised (a server-key-verified strict epoch bump, Task 8.2):
 * the provider DROPS local vault state + re-baselines at the new epoch instead of
 * alarming. A normal clean page carries `reset:false`.
 */
export type GateResult = { ok: true; reset: boolean } | { ok: false; reason: string };

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

  /**
   * Re-arm the tracker for a SANCTIONED-RESET re-pass (Task 8.2). After a verified
   * strict epoch bump the provider drops local state and re-paginates the fresh
   * (epoch-bumped) seq space from `since=0`. We seed an EMPTY accumulator and clear
   * the in-memory baseline so the re-pass does NOT run the stale-root gate against
   * the pre-reset root — `commitBaseline` then persists a fresh signed root at the
   * new epoch/cursor. The bump is server-key-verified by `ingestPage` BEFORE this
   * is ever called, so dropping the baseline here cannot mask a hostile rollback.
   */
  beginReset(): void {
    this.accState = new Map();
    this.baseline = null;
  }

  /**
   * Ingest one `/state` page: monotonicity + root gate.
   *
   * A server-key-VERIFIED strict epoch bump is evaluated FIRST and short-circuits
   * BOTH gates (it is a sanctioned reset, Task 8.2 / finding #14): the page is
   * reported `ok` with `reset:true`, and the provider drops local state + has the
   * tracker re-baseline at the new epoch. WITHOUT a verified strict bump, a cursor
   * regression or a root divergence still alarms (Task 4.2 is NOT weakened).
   */
  async ingestPage(page: LoadPage): Promise<GateResult> {
    if (this.accState === null) await this.beginLoad(new Map());
    const epochOk = this.recogniseEpoch(page);
    if (epochOk) return { ok: true, reset: true }; // sanctioned reset — provider drops + re-baselines
    const mono = this.checkMonotonic(page);
    if (!mono.ok) return mono;
    this.fold(page.entries);
    if (this.baseline) {
      const verdict = this.checkRoot();
      if (!verdict.ok) return verdict;
    }
    return { ok: true, reset: false };
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
  private checkMonotonic(page: LoadPage): { ok: true } | { ok: false; reason: string } {
    if (page.cursor < page.since) {
      return { ok: false, reason: `cursor regressed: ${page.cursor} < since ${page.since}` };
    }
    return { ok: true };
  }

  /**
   * Fold the post-reset state into the accumulator (Task 8.2). The reset re-pass
   * pulls the fresh seq space UNGATED (the bump is already verified), so the
   * provider folds those entries here before `commitBaseline` signs the new root —
   * keeping the re-baselined root correct even for a NON-empty reset.
   */
  foldReset(entries: StateEntry[]): void {
    this.fold(entries);
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
  private checkRoot(): { ok: true } | { ok: false; reason: string } {
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

  /**
   * Re-sign the local baseline after the wallet's OWN flush advanced the server
   * (Task 7.1/7.3). The wallet is the only writer, so its committed writes must
   * advance the signed root — otherwise the next `load()` would see its own
   * entries as an unauthored delta and false-alarm a rollback. `known` is the
   * provider's post-flush authoritative state; the epoch is carried forward.
   */
  async rebaseline(cursor: number, known: Map<string, EntryState>): Promise<void> {
    if (!this.config.baseline || !this.walletPriv) return;
    const root = computeRoot(known);
    const epoch = this.baseline?.epoch ?? 0;
    const sig = signRoot(this.walletPriv, this.bindingFor(cursor, root));
    const baseline: SignedBaseline = { cursor, root, sig, epoch };
    this.baseline = baseline;
    await this.config.baseline.set(this.baselineKey(), JSON.stringify(baseline));
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
    // Storage scope uses the LITERAL network (migration-v2 trap), NOT the
    // canonical vault literal used for signing — see LoadDeltaConfig.
    const scope = this.config.storageNetwork ?? this.config.network;
    return `vault_baseline:${scope}:${this.ownerId}`;
  }
}
