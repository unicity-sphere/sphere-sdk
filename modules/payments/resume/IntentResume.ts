/**
 * E.3/E.4 intent resume: the sign-in replay of this wallet's OPEN send intents
 * — payload decode, the per-op re-run under the ORIGINAL transferId, the §7
 * partial-completion accounting and the resumed SENT record. The token map,
 * `save()`, the delivery journal writer and the send's own pipeline stay in
 * PaymentsModule, reached via {@link IntentResumeHost}.
 */

import type { Token } from '../../../types';
import type { ITokenEngine, SphereToken } from '../../../token-engine';
import {
  CheckpointPersistFailedError,
  CheckpointTrustbaseMismatchError,
  ProofUnconfirmedError,
  type SplitCheckpointStore,
  SplitCheckpointLostError,
  TransferConflictError,
} from '../../../token-engine';
import { decodeTokenBlob } from '../../../token-engine/token-blob';
import type { TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import type { DeliveryProvider } from '../../../transport/delivery-provider';
import type { OperationOutcome, SendOperation } from '../SendOperations';
import type {
  CertifyContext,
  IntentPayloadV1,
  PaymentsModuleDependencies,
  PendingV2Delivery,
  TransactionHistoryEntry,
} from '../PaymentsModule';
import { extractStateHashFromSdkData } from '../PaymentsModule';
import { logger } from '../../../core/logger';
import { SphereError, PartialSendConflictError } from '../../../core/errors';
import { hexToBytes } from '../../../core/crypto';
import { decryptField } from '../../../core/field-encryption';

/**
 * The exact PaymentsModule members this feature reaches back for. Deliberately
 * narrow: the token map is READ through {@link IntentResumeHost.getHeldToken}
 * and mutated only through the module's own `removeToken` / `storeEngineToken`
 * — resume never becomes a second writer of the module's core state.
 */
export interface IntentResumeHost {
  /** Live dependency handle (identity / storage / emitEvent / walletApi / tokenEngine); null before initialize(). */
  readonly deps: PaymentsModuleDependencies | null;
  /** The composed delivery port — `custody === 'inventory'` selects the server-apply path (§7). */
  readonly delivery: DeliveryProvider | null;
  /** load() gate — resume must observe the loaded token map before replaying. */
  readonly loaded: boolean;
  readonly loadedPromise: Promise<void> | null;
  /** Throws unless the module has dependencies. */
  ensureInitialized(): void;
  /** S6 field-encryption key for this identity (the intent payload envelope). */
  getFieldEncryptionKey(): Uint8Array;
  /** The provider the sources are read from and the spend is applied to. */
  getActiveTokenStorageProvider(): TokenStorageProvider<TxfStorageDataBase> | null;
  /** E.4 burn checkpoint store, or undefined when the port lacks the progress capability. */
  getCheckpointStore(): SplitCheckpointStore | undefined;
  /** The send's own engine op — resume re-runs it under the ORIGINAL (transferId, opIndex). */
  certifyOperation(op: SendOperation, ctx: CertifyContext): Promise<OperationOutcome>;
  /** The hoisted delivery pass (#699) over journaled + freshly certified blobs. */
  deliverCommittedBlobs(
    blobs: readonly string[],
    recipientPubkey: string,
    transferId: string,
    memo?: string,
  ): Promise<boolean>;
  /** §7 steps 4+6 — the single idempotent server apply carrying the transferId. */
  applyInventoryDelta(
    engine: ITokenEngine,
    transferId: string,
    spentStates: readonly { tokenId: string; stateHash: string }[],
    changeOutput: SphereToken | null | undefined,
    storage: TokenStorageProvider<TxfStorageDataBase>,
  ): Promise<void>;
  /** Persist a recovered engine token (the split change) into the module's token map. */
  storeEngineToken(
    engine: ITokenEngine,
    token: SphereToken,
    opts?: { criticalSave?: boolean },
  ): Promise<{ uiToken: Token; added: boolean }>;
  /** Read-only view of the module's token map — resume never writes it directly. */
  getHeldToken(id: string): Token | undefined;
  /** The module's own token removal (state-gated) — the sole writer of the token map. */
  removeToken(tokenId: string, excludeReservationId?: string, expectedStateHash?: string): Promise<void>;
  /** #621: the delivery journal, read to re-deliver an already-certified op. */
  loadPendingV2Deliveries(): Promise<PendingV2Delivery[]>;
  /** §10 history writer. */
  addToHistory(entry: Omit<TransactionHistoryEntry, 'id' | 'dedupKey'>): Promise<void>;
  /** Registry lookup for the display symbol of a coin id. */
  getCoinSymbol(coinId: string): string;
  /** #441: the durable settling-request reconcile driven off this resume's outcome. */
  reconcileSettlingPaymentRequests(
    outcome: { resumed: string[]; conflicted: string[]; failed: string[] },
    openIntentIds: Set<string>,
    localIntents: Map<string, { status: 'open' | 'completed' | 'aborted'; abortPending: boolean }> | undefined,
    localReadFailed: boolean,
  ): Promise<void>;
}

export class IntentResume {
  constructor(private readonly host: IntentResumeHost) {}

  /**
   * E.3 resume: list this wallet's OPEN intents (server-side — any device),
   * decrypt each payload, and re-run the engine with the SAME transferId and
   * inputs — deterministic realization yields byte-identical transactions, so
   * an interrupted transfer completes instead of failing (proof fetch →
   * match-verify → apply, Part E). Called at sign-in (S4).
   */
  async resumeOpenIntents(): Promise<{ resumed: string[]; conflicted: string[]; failed: string[] }> {
    this.host.ensureInitialized();
    const walletApi = this.host.deps!.walletApi;
    const engine = this.host.deps!.tokenEngine;
    const outcome = { resumed: [] as string[], conflicted: [] as string[], failed: [] as string[] };
    if (!walletApi || !engine) return outcome;
    if (!this.host.loaded && this.host.loadedPromise) {
      await this.host.loadedPromise;
    }

    const intents = await walletApi.listIntents('open');

    // #676 (PR #681 review): read EVERY local intent disposition ONCE before the
    // loop (perf: one parse, not one per server-open intent). Best-effort — a
    // storage read error must NOT abort the whole resume (Copilot robustness),
    // but it also must NOT let us blindly resume: a server-`open` intent whose
    // local copy is aborted would re-execute → double-pay. So when the local
    // read is UNAVAILABLE (threw), we cannot prove any intent safe to resume and
    // DEFER them all (classify failed, retry next sign-in) — erring toward not
    // double-paying. A port without the capability (no local intent store) has
    // no divergence to honor, so it resumes on the server row as before.
    const localLookupSupported = typeof walletApi.getLocalIntentsMap === 'function';
    let localIntents: Map<string, { status: 'open' | 'completed' | 'aborted'; abortPending: boolean }> | undefined;
    let localReadFailed = false;
    if (localLookupSupported) {
      try {
        localIntents = await walletApi.getLocalIntentsMap!();
      } catch (err) {
        localReadFailed = true;
        logger.warn(
          'Payments',
          'Could not read local intent dispositions (#676) — deferring resume of all open intents this sign-in to avoid re-executing a locally-aborted send:',
          err,
        );
      }
    }

    for (const intent of intents) {
      // #676: honor a LOCAL abort the server never learned about. A clean
      // pre-certification send failure soft-aborts the intent best-effort; when
      // that abort's server leg cannot land (dead backend), abortIntent flips
      // the LOCAL copy to aborted+abortPending while the SERVER row stays 'open'.
      // listIntents('open') (a plain server GET) hands that row back, and
      // re-executing it would RE-SPEND sources the failure handler restored to
      // 'confirmed' — paying the recipient a second time for a send the user
      // already watched fail.
      if (localLookupSupported) {
        if (localReadFailed) {
          // Local disposition unknown (read threw) — cannot prove this intent is
          // safe to resume, so defer it rather than risk re-executing a locally
          // aborted send. The next sign-in retries once storage is healthy.
          outcome.failed.push(intent.transferId);
          continue;
        }
        const localIntent = localIntents!.get(intent.transferId);
        // Local copy aborted (or abort pending) → do NOT resume; re-attempt the
        // abort to converge the server and classify with the conflicted
        // (aborted, re-plan) bucket. A missing local copy (fresh device) leaves
        // the server row authoritative and resume proceeds, unchanged.
        if (localIntent && (localIntent.status === 'aborted' || localIntent.abortPending)) {
          logger.warn(
            'Payments',
            `Intent ${intent.transferId.slice(0, 8)}… is locally aborted (the abort never reached the server) — converging, NOT resuming (#676)`,
          );
          try {
            await walletApi.abortIntent(intent.transferId);
          } catch (abortErr) {
            logger.warn('Payments', 'abortIntent during resume-skip failed (retried next sign-in):', abortErr);
          }
          outcome.conflicted.push(intent.transferId);
          continue;
        }
      }
      let payload: IntentPayloadV1;
      try {
        const plain = decryptField(this.host.getFieldEncryptionKey(), intent.payload);
        payload = JSON.parse(plain) as IntentPayloadV1;
        if (payload.v !== 2 || !Array.isArray(payload.direct)) {
          // A pre-E.4 (v:1) intent has no burn checkpoint, so running it down the
          // v:2 path would raise SplitCheckpointLostError and keep it open
          // forever. Refuse it instead: it lands in `failed`, stays OPEN and
          // untouched on the server, and is visible to an operator by name —
          // nothing is executed, nothing is aborted.
          throw new SphereError(
            `Unsupported intent payload shape (v=${String(payload.v)}) — not resumable by this wallet version`,
            'VALIDATION_ERROR',
          );
        }
      } catch (err) {
        logger.warn('Payments', `Intent ${intent.transferId.slice(0, 8)}… payload undecodable — skipped:`, err);
        outcome.failed.push(intent.transferId);
        continue;
      }
      try {
        await this.resumeIntent(intent.transferId, payload);
        outcome.resumed.push(intent.transferId);
      } catch (err) {
        if (err instanceof TransferConflictError) {
          // E.2 lost race: abort (soft), never apply the foreign proof. The
          // caller re-plans the remainder under a NEW transferId.
          logger.warn('Payments', `Intent ${intent.transferId.slice(0, 8)}… lost its source to a concurrent transfer — aborted`);
          try {
            await walletApi.abortIntent(intent.transferId);
          } catch (abortErr) {
            logger.warn('Payments', 'abortIntent during resume failed:', abortErr);
          }
          outcome.conflicted.push(intent.transferId);
        } else if (err instanceof PartialSendConflictError) {
          // §7 PARTIAL completion: ≥1 leg forward-completed (delivered + recorded, intent completed by
          // applyDelta) before a LATER source was lost to a foreign tx. Classify it `resumed` — this is
          // the durable no-double-pay guard: reconcileSettlingPaymentRequests resolves any linked
          // request 'paid' via the `resumed || local-completed` branch and NEVER reverts it to payable,
          // so the delivered legs are never re-paid. resumeIntent already wrote the delivered-amount SENT
          // history and emitted 'send:partial-remainder'; the app re-plans ONLY the shortfall under a
          // NEW transferId (a background resume never auto-sends).
          logger.warn(
            'Payments',
            `Intent ${intent.transferId.slice(0, 8)}… PARTIALLY completed — delivered legs final; ${err.remainingAmount} remainder owed (re-plan only the shortfall)`,
          );
          outcome.resumed.push(intent.transferId);
        } else if (err instanceof SplitCheckpointLostError || err instanceof CheckpointTrustbaseMismatchError) {
          // E.4: a burn-certified split is STUCK on an unrecoverable-for-now checkpoint error (lost
          // checkpoint, or a trust-base rotation). The intent stays OPEN (funds in-flight, never
          // lost), but this is NOT a transient blip — emit a distinct LOUD signal so the operator
          // can act (the drain remedy) rather than wait on a silent retry.
          logger.warn('Payments', `Intent ${intent.transferId.slice(0, 8)}… split checkpoint STUCK (${err.code}) — kept open, needs attention:`, err);
          this.host.deps!.emitEvent('split:checkpoint-stuck', {
            transferId: intent.transferId,
            code: err.code,
            error: err.message,
          });
          outcome.failed.push(intent.transferId);
        } else {
          // Transient — the intent stays open; the next sign-in retries.
          logger.warn('Payments', `Intent ${intent.transferId.slice(0, 8)}… resume failed (stays open):`, err);
          outcome.failed.push(intent.transferId);
        }
      }
    }

    // #441: drive deferred-paid resolution off the DURABLE journal (not in-memory
    // request presence) — this is the sole seam where a settling transfer
    // completes (resumed), aborts (conflicted), or stays open (failed).
    await this.host.reconcileSettlingPaymentRequests(
      outcome,
      new Set(intents.map((i) => i.transferId)),
      localIntents,
      localReadFailed,
    );

    return outcome;
  }


  /**
   * Re-run one intent end-to-end: getToken (works for tombstoned rows — §5.3
   * recovery surface), engine re-run under the original transferId, journaled
   * delivery, the single §7 apply (inventory custody only), uniform close,
   * and the SENT history record (dedupKey'd by transferId — idempotent).
   */
  private async resumeIntent(transferId: string, payload: IntentPayloadV1): Promise<void> {
    const engine = this.host.deps!.tokenEngine!;
    const walletApi = this.host.deps!.walletApi!;
    const provider = this.host.getActiveTokenStorageProvider();
    if (!provider) throw new SphereError('No token storage provider for intent resume', 'STORAGE_ERROR');
    const serverApply = this.host.delivery!.custody === 'inventory';

    // The SAME certify context the original send used — (transferId, opIndex)
    // rebuilds byte-identical transactions (§8.1).
    const checkpointStore = this.host.getCheckpointStore();
    const ctx: CertifyContext = {
      engine,
      transferId,
      recipientChainPubkey: hexToBytes(payload.recipient),
      recipientChainPubkeyHex: payload.recipient,
      selfChainPubkey: hexToBytes(this.host.deps!.identity.chainPubkey),
      coinId: payload.coinId,
      ...(payload.memo !== undefined ? { memo: payload.memo } : {}),
      ...(checkpointStore ? { checkpointStore } : {}),
    };

    // #621: re-deliver, never re-certify. A journaled blob for (transferId, opIndex) means the op
    // already certified in the original send (the intent stayed open on a LATER failure, e.g.
    // applyDelta). Re-running the engine on the now-spent source would raise TransferConflictError —
    // re-deliver the stored blob instead (idempotent). The engine runs only for an unjournaled op.
    const journaled = await this.journaledByOp(transferId);
    const blobs: string[] = []; // journaled + freshly certified, delivered in ONE pass
    const spent: string[] = []; // DELIVERED legs only (§7 forward-completion)
    let conflicted = false; // ≥1 source was lost to a FOREIGN tx (§8.1) — that leg delivered nothing
    let firstConflict: TransferConflictError | undefined;
    // The undelivered shortfall = Σ of the CONFLICTED legs' values, computed from the UNDELIVERED
    // side: a conflicted leg is always FRESH (a journaled leg re-delivers, it never conflicts) so its
    // source is in hand, while a journaled leg's source is already gone from this.tokens.
    let undeliveredAmount = 0n;

    for (const [opIndex, genesisId] of payload.direct.entries()) {
      const existing = journaled.get(opIndex);
      if (existing) {
        blobs.push(existing.tokenBlob);
        spent.push(genesisId);
        continue;
      }
      const source = await engine.decodeToken(await provider.getToken(genesisId));
      const outcome = await this.host.certifyOperation(
        {
          kind: 'direct',
          opIndex,
          uiTokenId: `v2_${genesisId}`,
          genesisId,
          sourceSdkData: '',
          sdkToken: source,
          deliveredAmount: engine.balanceOf(source, payload.coinId),
        },
        ctx
      );
      if (outcome.error !== undefined) {
        if (!(outcome.error instanceof TransferConflictError)) throw outcome.error;
        // §8.1: a resume conflict = a DIFFERENT (foreign) transaction consumed the source. Our own
        // resume gets the existing proof back as a hash-MATCH, no throw (AC-E1/E2 vs AC-E4), so this
        // leg delivered NOTHING. NEVER record it spent — that false-marks the intent PAID.
        conflicted = true;
        firstConflict ??= outcome.error;
        undeliveredAmount += engine.balanceOf(source, payload.coinId);
        logger.warn('Payments', `Resume op ${opIndex} lost its source to a concurrent transfer — not delivered (§8.1/#4):`, outcome.error);
        continue;
      }
      blobs.push(outcome.tokenBlob!);
      spent.push(genesisId);
    }

    let changeOutput: SphereToken | null = null;
    if (payload.split) {
      // The split's opIndex follows the direct ops — replayed from the intent's order (§8.1).
      const splitOpIndex = payload.direct.length;
      let splitDelivered = false;
      {
        // E.4 (sphere-sdk#501): a split resumes THROUGH its burn checkpoint — split() rebuilds BOTH
        // outputs from the stored proof (already-certified legs match-verify), so the change is
        // recovered even when the split already certified. Re-delivering the journaled blob instead
        // (the pre-E.4 shortcut, #634) left the change unpersisted and the following applyDelta
        // recorded the spend with an empty `added`.
        const source = await engine.decodeToken(await provider.getToken(payload.split.tokenId));
        const outcome = await this.host.certifyOperation(
          {
            kind: 'split',
            opIndex: splitOpIndex,
            uiTokenId: `v2_${payload.split.tokenId}`,
            genesisId: payload.split.tokenId,
            sourceSdkData: '',
            sdkToken: source,
            deliveredAmount: BigInt(payload.split.splitAmount),
            remainderAmount: BigInt(payload.split.remainderAmount),
          },
          ctx
        );
        if (outcome.error === undefined) {
          changeOutput = outcome.changeOutput ?? null;
          // critical (#515 F2): own-storage custody — persist-or-stay-open; a throw keeps the intent
          // open and the next sign-in re-runs it.
          if (!serverApply && changeOutput) {
            await this.host.storeEngineToken(engine, changeOutput, { criticalSave: true });
          }
          blobs.push(outcome.tokenBlob!);
          splitDelivered = true;
        } else {
          splitDelivered = this.classifyResumeSplitFailure(outcome.error, (err) => {
            conflicted = true;
            firstConflict ??= err;
            undeliveredAmount += BigInt(payload.split!.splitAmount);
          });
        }
      }
      if (splitDelivered) spent.push(payload.split.tokenId);
    }

    // §3.1 (#621): non-fatal — a recipient-side/transient delivery failure must NOT throw out of
    // resume (the applyDelta below must still reconcile the server); the blob stays journaled.
    await this.host.deliverCommittedBlobs(blobs, payload.recipient, transferId, payload.memo);

    // §7/§8.1: NOTHING was delivered — the (only/first) source was consumed by a FOREIGN tx. Surface
    // the bare conflict: resumeOpenIntents soft-aborts the intent → the linked settling request
    // reverts to payable and is re-paid IN FULL. Never applyDelta/complete an intent that delivered
    // nothing (that is the #4 false-paid). The delivered case (≥1 leg) is handled after the tail.
    if (conflicted && spent.length === 0) throw firstConflict!;

    if (serverApply) {
      // M7: replay the spend with the PROTOCOL states persisted at send time, so knownSpends records
      // the exact spent state (→ M4 can repair a stuck-active server row instead of leaving a
      // phantom). Legacy payloads (no spentStates) fall back to bare knownSpends.
      await this.host.applyInventoryDelta(
        engine,
        transferId,
        spent.map((id) => ({ tokenId: id, stateHash: payload.spentStates?.[id]?.protocol ?? '' })),
        changeOutput,
        provider // the one the sources were read from, captured for the whole resume
      );
    }

    await this.dropResumedSources(spent, transferId, payload);

    // §7 PARTIAL completion: ≥1 leg delivered, then a LATER source was lost to a FOREIGN tx. The
    // delivered legs' spends are already recorded by applyDelta above, which also COMPLETED the
    // intent. No double-pay, durably: resumeOpenIntents classifies this transferId `resumed`, so
    // reconcileSettlingPaymentRequests resolves any linked request 'paid' and NEVER reverts it to
    // payable. completeIntent FIRST (idempotent) so the best-effort history/event below can never
    // wedge it open. The remainder event + PartialSendConflictError surface the shortfall so the app
    // re-plans ONLY it under a NEW transferId (§7). NOTE: the event is a live-session hint; a
    // crash-durable remainder re-plan is a tracked follow-up.
    if (conflicted) {
      const remaining = undeliveredAmount > 0n ? undeliveredAmount : 0n;
      const delivered = BigInt(payload.amount) - remaining;
      await walletApi.completeIntent(transferId);
      await this.recordResumedSentHistory(payload, transferId, delivered > 0n ? delivered.toString() : '0', spent[0]);
      this.host.deps!.emitEvent('send:partial-remainder', {
        transferId,
        remainingAmount: remaining.toString(),
        coinId: payload.coinId,
        recipientPubkey: payload.recipient,
      });
      throw new PartialSendConflictError(
        'Resume: part of the payment was delivered before a source was consumed by a concurrent transfer — the delivered legs are final; re-plan ONLY the remainder.',
        transferId,
        spent, // the DELIVERED genesisIds — never the conflicted leg
        remaining.toString(),
        firstConflict,
      );
    }

    // E.3 uniform close (idempotent; the apply above usually already did it).
    await walletApi.completeIntent(transferId);
    await this.recordResumedSentHistory(payload, transferId, payload.amount, payload.direct[0]);
  }

  /**
   * A resumed split that produced no output: a lost source means the leg delivered
   * nothing (returns false), and every checkpoint failure keeps the intent open by
   * throwing. There is no path here that records the spend.
   */
  private classifyResumeSplitFailure(
    error: unknown,
    onConflict: (err: TransferConflictError) => void
  ): boolean {
    if (error instanceof ProofUnconfirmedError) throw error; // #631 keep-open (indeterminate)
    // KEEP-OPEN: the burn is certified and a split-mint stateId is HKDF-derived (never a foreign
    // spend), so resume — rebuilding from the checkpoint — is the only exit. Never record the
    // spend, never abort.
    if (
      error instanceof CheckpointPersistFailedError ||
      error instanceof SplitCheckpointLostError ||
      error instanceof CheckpointTrustbaseMismatchError
    ) {
      throw error;
    }
    if (error instanceof TransferConflictError) {
      // §8.1: the split SOURCE (burn leg) was consumed by a FOREIGN tx under a DIFFERENT transferId
      // — the split delivered NOTHING. Do NOT record it as spent (that false-marks the intent paid).
      onConflict(error);
      logger.warn('Payments', 'Resume split: source lost to a concurrent transfer — not delivered (§8.1/#4):', error);
      return false;
    }
    throw error;
  }

  /**
   * Drop the local records of the sources a resume consumed (present when
   * resuming on the originating device). M7: each removal carries the LOCAL state
   * we spent, so a source a concurrent claim reactivated to a NEW state (a
   * self-send round-trip) is KEPT, not destroyed.
   */
  private async dropResumedSources(
    spent: readonly string[],
    transferId: string,
    payload: IntentPayloadV1
  ): Promise<void> {
    const engine = this.host.deps!.tokenEngine!;
    for (const genesisId of spent) {
      const local = this.host.getHeldToken(`v2_${genesisId}`);
      if (!local) continue;
      const spentLocal = payload.spentStates?.[genesisId]?.local;
      if (spentLocal !== undefined && spentLocal !== '') {
        await this.host.removeToken(local.id, transferId, spentLocal);
        continue;
      }
      // LEGACY payload (no persisted spent state — an in-flight intent from before M7, hit during a
      // rolling deploy). removeToken cannot state-gate, so a reactivated source would be destroyed
      // (permanently, on own storage). FAIL-CLOSED: drop it only if the aggregator confirms its
      // CURRENT state is spent; unverifiable → keep. Never destroy value we cannot prove is spent.
      let spentOnChain = false;
      try {
        if (local.sdkData) {
          spentOnChain = await engine.isSpent(await engine.decodeToken(decodeTokenBlob(hexToBytes(local.sdkData))));
        }
      } catch {
        spentOnChain = false;
      }
      if (spentOnChain) {
        await this.host.removeToken(local.id, transferId, extractStateHashFromSdkData(local.sdkData));
      } else {
        logger.warn(
          'Payments',
          `Resume(legacy): source ${genesisId.slice(0, 8)}... is unspent on-chain — keeping (reactivated), not dropping`
        );
      }
    }
  }

  /** §10: the SENT record — same dedupKey as the original attempt, so a resume after the history POST is a server-side no-op. */
  private async recordResumedSentHistory(
    payload: IntentPayloadV1,
    transferId: string,
    amount: string,
    tokenGenesisId: string | undefined
  ): Promise<void> {
    await this.host.addToHistory({
      type: 'SENT',
      amount,
      coinId: payload.coinId,
      symbol: this.host.getCoinSymbol(payload.coinId),
      timestamp: Date.now(),
      recipientPubkey: payload.recipient,
      memo: payload.memo,
      transferId,
      tokenId: tokenGenesisId ? `v2_${tokenGenesisId}` : undefined,
    });
  }

  /**
   * #621: journaled finished blobs for an intent, keyed by op position. opIndex when present,
   * else positional among the intent's entries (legacy entries journaled in op order). Resume
   * uses this to re-deliver an already-certified op instead of re-running the engine on its spent source.
   */
  private async journaledByOp(transferId: string): Promise<Map<number, PendingV2Delivery>> {
    const mine = (await this.host.loadPendingV2Deliveries()).filter((e) => e.transferId === transferId);
    const byOp = new Map<number, PendingV2Delivery>();
    mine.forEach((e, i) => byOp.set(e.opIndex ?? i, e));
    return byOp;
  }
}
