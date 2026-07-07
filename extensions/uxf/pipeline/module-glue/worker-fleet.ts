/**
 * Worker fleet auto-install — Phase 5 [B] extraction from
 * PaymentsModule.ts `initialize()`.
 *
 * The `initialize()` body carries ~1,475 lines of [B] extension-bound
 * worker auto-install wiring. This file receives that wiring in two
 * behaviour-preserving installers so the facade `initialize()`
 * collapses to the survive-bound prefix (field resets, subscriptions,
 * storage-event wiring) plus a small number of installer callouts.
 *
 * Two installers, not one, because the middle of the block owns the
 * default {@link IngestWorkerPool} — whose `processToken` closure
 * calls into a stack of PaymentsModule-private helpers
 * (`parseTokenInfo` module-scope, `createSigningService`,
 * `finalizeTransferToken`, `addToken`, `resolveSenderInfo`,
 * `addToHistory`) that would require a very wide host shim to expose.
 * The pool block therefore stays on the facade, sandwiched between
 * the two extracted installers:
 *
 *   [SURVIVE prefix]
 *   installUxfAuxiliaryWorkers(host)        <-- SendingRecovery,
 *                                                SentReconciliation,
 *                                                NostrPersistenceVerifier,
 *                                                SpentStateRescan,
 *                                                TombstoneGc
 *   [IngestWorkerPool default block]        <-- stays on facade
 *   installUxfFinalizationStack(host)       <-- AbortController,
 *                                                sharedPerTokenMutex,
 *                                                FinalizationWorkerSender,
 *                                                FinalizationWorkerRecipient,
 *                                                InclusionProofImporter,
 *                                                RevalidateCascadedRunner
 *
 * See uxfv2-phase-5-payments-disposition.md — the `initialize()`
 * ledger entry says: "the entire body of `initialize()` past line
 * ~2000 is [B] extension wiring."
 */

import { logger } from '../../../../core/logger';
import { SphereError } from '../../../../core/errors';
import type { Token, SphereEventType, SphereEventMap } from '../../../../types';
import type { PaymentsModuleDependencies } from '../../../../modules/payments/PaymentsModule';
import type { UxfTransferOutboxEntry } from '../../types/uxf-outbox';
import type { UxfSentLedgerEntry } from '../../types/uxf-sent';
import type { OutboxWriter } from '../../profile/outbox-writer';
import type { SentLedgerWriter } from '../../profile/sent-ledger-writer';
import { PerTokenMutex } from '../../profile/per-token-mutex';
import {
  SendingRecoveryWorker,
  type SendingRecoveryWorkerDeps,
} from '../sending-recovery-worker';
import {
  SentReconciliationWorker,
  type SentReconciliationWorkerDeps,
} from '../sent-reconciliation-worker';
import {
  NostrPersistenceVerifier,
  type NostrPersistenceVerifierDeps,
  type VerifyOutcome,
} from '../nostr-persistence-verifier';
import {
  SpentStateRescanWorker,
  type SpentStateRescanWorkerDeps,
  type TransitionToAuditFn,
} from '../spent-state-rescan-worker';
import {
  TombstoneGcWorker,
  type TombstoneGcWorkerDeps,
} from '../tombstone-gc-worker';
import type { FinalizationWorkerSender, RequestContext } from '../finalization-worker-sender';
import type { PersistedRequestContext } from '../../profile/finalization-queue-storage-adapter';
import type { FinalizationWorkerRecipient } from '../finalization-worker-recipient';
import type { FinalizationQueue, FinalizationQueueStorage } from '../finalization-queue';
import type { InclusionProofImporter } from '../import-inclusion-proof';
import type { RevalidateCascadedRunner } from '../revalidate-cascaded';
import { computeAddressId } from '../../profile/types.js';
import {
  buildDefaultFinalizationWorkerSender,
  buildDefaultFinalizationWorkerRecipient,
  buildDefaultInclusionProofImporter,
  buildDefaultRevalidateCascadedRunner,
  type RecipientFinalizationContext,
} from './composition';
// eslint-disable-next-line no-restricted-imports
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
// eslint-disable-next-line no-restricted-imports
import type { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
// eslint-disable-next-line no-restricted-imports
import type { TransferTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction';

/**
 * Feature flag subset the fleet installers gate on. Mirrors the shape
 * of `Required<UxfTransferFeatures>` on PaymentsModule but declared as
 * a structural interface so the facade can pass the wider object
 * without needing a re-shape.
 */
export interface UxfWorkerFleetFeatures {
  readonly recoveryWorker: boolean;
  readonly sentReconciliationWorker: boolean;
  readonly nostrPersistenceVerifier: boolean;
  readonly spentStateRescan: boolean;
  readonly tombstoneGcWorker: boolean;
  readonly senderUxf: boolean;
  readonly recipientUxf: boolean;
  readonly finalizationWorker: boolean;
}

/**
 * G7 — persisted mirror for the recipient worker's in-memory context
 * Maps. Structural type so this file does not have to import the
 * concrete OrbitDb/InMemory adapter classes.
 */
export interface RecipientContextStorageAdapter {
  listAllFinalizationContexts(
    addressId: string,
  ): Promise<Map<string, RecipientFinalizationContext>>;
  listAllRequestContexts(
    addressId: string,
  ): Promise<Map<string, PersistedRequestContext>>;
  writeFinalizationContext(
    addressId: string,
    tokenId: string,
    ctx: RecipientFinalizationContext,
  ): Promise<void>;
  writeRequestContext(
    addressId: string,
    requestId: string,
    ctx: RequestContext,
  ): Promise<void>;
}

/**
 * Host shim exposed by PaymentsModule for the worker-fleet auto-
 * installers. Owns the readable + writable slots the installers need
 * (matching the private-field access previously used inline), plus a
 * few bound method callables (SENT-write, defaultSpentStateTransition,
 * emit, save, finalizeTransferToken) so the extension file has no
 * static reference to the facade instance.
 *
 * The facade builds a fresh host per call site — see PaymentsModule
 * `workerFleetHost()`.
 */
export interface UxfWorkerFleetHost {
  /** Feature-flag gates for the auto-install checks. */
  readonly features: UxfWorkerFleetFeatures;

  /**
   * Fully-initialized dependencies bundle. The facade guarantees `deps`
   * is set immediately before invoking any installer; installers can
   * dereference without null checks.
   */
  readonly deps: PaymentsModuleDependencies;

  // ---- SendingRecoveryWorker ---------------------------------------
  getSendingRecoveryWorker(): SendingRecoveryWorker | null;
  setSendingRecoveryWorker(w: SendingRecoveryWorker | null): void;

  // ---- SentReconciliationWorker ------------------------------------
  getSentReconciliationWorker(): SentReconciliationWorker | null;
  setSentReconciliationWorker(w: SentReconciliationWorker | null): void;

  // ---- NostrPersistenceVerifier ------------------------------------
  getNostrPersistenceVerifier(): NostrPersistenceVerifier | null;
  setNostrPersistenceVerifier(w: NostrPersistenceVerifier | null): void;

  // ---- SpentStateRescanWorker --------------------------------------
  getSpentStateRescanWorker(): SpentStateRescanWorker | null;
  setSpentStateRescanWorker(w: SpentStateRescanWorker | null): void;
  getSpentStateRescanTransitionToAudit(): TransitionToAuditFn | null;
  /**
   * Bound method reference for the default spent-state transition
   * (fallback when the operator has not installed a custom
   * `transitionToAudit`). The facade passes
   * `this.defaultSpentStateTransition.bind(this)`.
   */
  readonly defaultSpentStateTransition: TransitionToAuditFn;
  /** Bound accessor for the extract-current-state-hash helper. */
  extractCurrentStateHash(token: Token): string;
  /**
   * Live iterable over the current tokens map. Called each scan cycle
   * so the worker sees post-init updates.
   */
  getTokensIterable(): Iterable<Token>;
  /**
   * Resolve the current identity's fallback pubkey. Returns `null`
   * when identity is missing.
   */
  getFallbackChainPubkey(): string | null;
  /**
   * Extract the current-state pubkey from a token's sdkData. Used by
   * the spent-state rescan wallet-scoped isSpent wrapper.
   */
  extractCurrentStatePublicKeyHexFromSdkData(
    sdkData: string | undefined,
  ): Promise<string | null>;

  // ---- TombstoneGcWorker -------------------------------------------
  getTombstoneGcWorker(): TombstoneGcWorker | null;
  setTombstoneGcWorker(w: TombstoneGcWorker | null): void;

  // ---- Profile-resident writers ------------------------------------
  /** Bound getter — the closure MUST re-fetch on each call. */
  getOutboxWriter(): OutboxWriter | null;
  /** Bound getter — the closure MUST re-fetch on each call. */
  getSentLedgerWriter(): SentLedgerWriter | null;

  // ---- Shared state Maps + writers ---------------------------------
  /** Shared reference to the in-memory sender outbox map. */
  readonly senderOutboxMap: Map<string, UxfTransferOutboxEntry>;
  /** Shared reference to the sender-side per-requestId context map. */
  readonly senderRequestContextMap: Map<string, RequestContext>;
  /** Shared reference to the recipient-side per-requestId context map. */
  readonly recipientRequestContextMap: Map<string, RequestContext>;
  /** Shared reference to the recipient-side per-tokenId context map. */
  readonly recipientFinalizationContext: Map<string, RecipientFinalizationContext>;
  /** Shared reference to the tokens map (read by the recipient-worker
   *  dispositionWriter to look up local tokens by id). */
  readonly tokens: Map<string, Token>;

  /**
   * Bound SENT-write helper — pre-bound by the facade so recovery-
   * worker closures don't have to reach through `this`. Issue #97
   * steelman C3 pattern.
   */
  writeSentEntryFromOutbox(
    entry: UxfTransferOutboxEntry,
    source: string,
  ): Promise<'success' | 'failed' | 'skipped'>;

  // ---- Finalization stack slots ------------------------------------
  /** Read the current finalization queue slot. */
  getRecipientFinalizationQueue(): FinalizationQueue | null;
  setRecipientFinalizationQueue(q: FinalizationQueue | null): void;

  /** Read the current recipient save-failure-streak clear callback. */
  getRecipientSaveFailureStreakClear(): (() => void) | null;
  setRecipientSaveFailureStreakClear(cb: (() => void) | null): void;

  /** Read the current shared per-tokenId mutex. */
  getSharedPerTokenMutex(): PerTokenMutex | null;
  setSharedPerTokenMutex(m: PerTokenMutex | null): void;

  /** Read the current worker abort controller. */
  getWorkerAbortController(): AbortController | null;
  setWorkerAbortController(c: AbortController | null): void;

  /** Read the current sender finalization worker slot. */
  getFinalizationWorkerSender(): FinalizationWorkerSender | null;
  setFinalizationWorkerSender(w: FinalizationWorkerSender | null): void;

  /** Read the current recipient finalization worker slot. */
  getFinalizationWorkerRecipient(): FinalizationWorkerRecipient | null;
  setFinalizationWorkerRecipient(w: FinalizationWorkerRecipient | null): void;

  /** Read the current inclusion-proof importer slot. */
  getInclusionProofImporter(): InclusionProofImporter | null;
  setInclusionProofImporter(i: InclusionProofImporter | null): void;

  /** Read the current revalidate-cascaded runner slot. */
  getRevalidateCascadedRunner(): RevalidateCascadedRunner | null;
  setRevalidateCascadedRunner(r: RevalidateCascadedRunner | null): void;

  /** Read the persisted FinalizationQueueStorage slot. */
  getRecipientFinalizationQueueStorage(): FinalizationQueueStorage | null;

  /** Read the persisted recipient-context adapter slot. */
  getRecipientContextStorage(): RecipientContextStorageAdapter | null;

  /** Write the hydration promise so the facade can expose it via
   *  `awaitRecipientContextHydration`. */
  setRecipientContextHydrationPromise(p: Promise<void> | undefined): void;

  /**
   * Bound method reference for {@link
   * PaymentsModule.finalizeTransferToken}. Consumed by the recipient
   * worker's dispositionWriter VALID branch (via
   * `buildDefaultFinalizationWorkerRecipient`).
   */
  finalizeTransferToken(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sourceToken: SdkToken<any>,
    transferTx: TransferTransaction,
    stClient: StateTransitionClient,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trustBase: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<SdkToken<any>>;

  /** Bound {@link PaymentsModule.save}. */
  save(): Promise<void>;

  /** Bound event emitter — mirrors PaymentsModuleDependencies.emitEvent
   *  but exposed on the host so installer code doesn't need to reach
   *  through `deps.emitEvent`. */
  emit<T extends SphereEventType>(type: T, data: SphereEventMap[T]): void;
}

// =============================================================================
// Auxiliary workers block: SendingRecovery / SentReconciliation /
// NostrPersistenceVerifier / SpentStateRescan / TombstoneGc
// =============================================================================

/**
 * Install the "auxiliary workers" auto-install fleet block. Runs
 * BEFORE the facade's IngestWorkerPool block.
 *
 * Behaviour-preserving move of PaymentsModule.ts initialize() lines
 * ~1756–~2176 (SendingRecovery through TombstoneGc).
 */
export function installUxfAuxiliaryWorkers(host: UxfWorkerFleetHost): void {
  // G6 — auto-install a default SendingRecoveryWorker when the gate
  // is on AND no consumer has already wired one. The auto-installed
  // worker reads from the in-memory `_senderOutboxMap` (same shim
  // FinalizationWorkerSender uses) and re-publishes via the injected
  // transport, preserving `bundleCid` for recipient-side replay LRU
  // (§6.3 / T.3.A idempotency contract).
  //
  // Bootstrap layers (Sphere) MAY override by installing a worker
  // wired against a Profile-backed `OutboxWriter` BEFORE
  // `initialize()` (the `!this.sendingRecoveryWorker` check preserves
  // that contract).
  if (
    host.features.recoveryWorker &&
    host.getSendingRecoveryWorker() === null
  ) {
    const senderOutboxMap = host.senderOutboxMap;
    const transport = host.deps.transport;
    const sphereEmit = host.deps.emitEvent;
    // Issue #97 — capture by closure so reads route through the
    // profile-resident writer when installed. The writer is the
    // source of truth across restarts; falling back to the in-memory
    // map preserves pre-#97 behaviour for callers that haven't wired
    // the profile-backed path yet.
    const getOutboxWriter = (): OutboxWriter | null => host.getOutboxWriter();
    // Issue #97 (steelman C3) — bind the SENT-write helper for the
    // recovery worker's `update` closure. The object-method-shorthand
    // inside `recoveryDeps.outbox` rebinds `this` to the outbox
    // surface itself, so we can't reach `this.writeSentEntryFromOutbox`
    // from there. Pre-bind at closure construction time.
    const writeSentEntryFromOutbox = host.writeSentEntryFromOutbox.bind(host);
    const recoveryDeps: SendingRecoveryWorkerDeps = {
      outbox: {
        async readAllNew(): Promise<ReadonlyArray<UxfTransferOutboxEntry>> {
          const writer = getOutboxWriter();
          if (writer !== null) {
            // Durable source-of-truth read. Tombstoned ids are skipped
            // by readAllNew per OutboxWriter contract.
            return await writer.readAllNew();
          }
          return Array.from(senderOutboxMap.values());
        },
        async update(
          id: string,
          mutator: (prev: UxfTransferOutboxEntry) => UxfTransferOutboxEntry,
        ): Promise<UxfTransferOutboxEntry> {
          const writer = getOutboxWriter();
          let prevStatus: UxfTransferOutboxEntry['status'] | null = null;
          let updated: UxfTransferOutboxEntry;
          if (writer !== null) {
            // Route through the writer so the §7.0 state-machine
            // validator fires AND the Lamport bump rule (§7.1) is
            // honored. Mirror the result into the in-memory map so
            // FinalizationOutboxWriter consumers stay coherent.
            //
            // Issue #97 (steelman C3 fix) — capture the pre-state so
            // we can detect a `'sending' → 'delivered'/'delivered-
            // instant'` arc and fire the SENT-write helper. The
            // dispatcher's transition hook is not involved on the
            // recovery-worker code path, so SENT must be written
            // here or recovered sends silently bypass the ledger.
            updated = await writer.update(id, (prev) => {
              prevStatus = prev.status;
              return mutator(prev);
            });
            senderOutboxMap.set(id, updated);
          } else {
            const existing = senderOutboxMap.get(id);
            if (existing === undefined) {
              throw new SphereError(
                `SendingRecoveryWorker.update: no entry at id "${id}"`,
                'VALIDATION_ERROR',
              );
            }
            prevStatus = existing.status;
            const next = mutator(existing);
            const bumped: UxfTransferOutboxEntry = {
              ...next,
              lamport: (existing.lamport ?? 0) + 1,
            };
            senderOutboxMap.set(id, bumped);
            updated = bumped;
          }

          // Issue #97 (C3) — detect terminal-success arc and write
          // SENT inline. CAS guard: only fire when the status
          // ACTUALLY transitioned (mutator may return prev unchanged
          // for self-loop no-ops; see sending-recovery-worker.ts
          // `transitionToDelivered`'s CAS pattern). Self-loop =
          // updated.status === prevStatus → skip.
          const terminalSuccess =
            (updated.status === 'delivered' || updated.status === 'delivered-instant') &&
            prevStatus !== updated.status;
          if (terminalSuccess) {
            // Use the pre-bound helper — the object-method-shorthand
            // here doesn't expose PaymentsModule.this.
            await writeSentEntryFromOutbox(
              updated,
              'sendingRecoveryWorker',
            );
          }

          return updated;
        },
      },
      republish: async (entry: UxfTransferOutboxEntry): Promise<void> => {
        // Re-publish via the same transport surface the original
        // send used. The recipient's replay-LRU short-circuits
        // duplicates by `bundleCid` (§6.3 / T.3.A) so a wasted publish
        // in the racing window is harmless.
        //
        // OUTBOX-SEND-FOLLOWUPS item #2 (final closure, PR #189) —
        // ALWAYS produce a `'uxf-cid'` payload, even when the entry's
        // original `deliveryMethod` was `'car-over-nostr'`. Item #6.a
        // (PR #188) flipped inline-CAR sends to ALSO pin the CAR
        // bytes to the sender's local IPFS node, so the recipient
        // CAN fetch the CID. Without that pin (pre-#6.a entries or
        // wallets without an IPFS publisher) the recipient's CID-
        // fetch path surfaces an error; the entry remains discoverable
        // via the verifier's next retention cycle and the operator
        // can intervene. This is no worse than the pre-PR behavior
        // (which throw → `'failed-transient'` → silent terminal),
        // and it correctly recovers the common case where the pin
        // exists.
        //
        // Custom workers that wire local CAR retention or per-entry
        // pin tracking can install their own republish via
        // `installSendingRecoveryWorker()` and refuse the downgrade
        // when their richer signals indicate the CID is unfetchable.
        switch (entry.deliveryMethod) {
          case 'cid-over-nostr':
          case 'car-over-nostr': {
            // The CID is the durable handle in both cases:
            //  - 'cid-over-nostr': original send pinned the CAR to
            //    IPFS before publishing the CID-by-reference shape.
            //  - 'car-over-nostr' (post-#6.a): inline send fired a
            //    best-effort local pin via the orchestrator's Step
            //    8.5 path; the CID is fetchable from the sender's
            //    IPFS node.
            //  - 'car-over-nostr' (pre-#6.a): NO local pin; the
            //    recipient's CID fetch will fail. The verifier's
            //    next cycle re-arms the entry (still at `'delivered'`
            //    OR re-armed back to `'sending'`); operator triage
            //    catches stuck cycles via tombstone GC.
            //
            // `mode === 'txf'` is a legacy outbox-mode discriminator
            // that does NOT belong to UXF wire payloads — map it to
            // `'instant'` for the advisory `mode` field; recipients
            // ignore it (§5.6).
            const payloadMode: 'conservative' | 'instant' =
              entry.mode === 'txf' ? 'instant' : entry.mode;
            await transport.sendTokenTransfer(
              entry.recipientTransportPubkey,
              {
                kind: 'uxf-cid',
                version: '1.0',
                mode: payloadMode,
                bundleCid: entry.bundleCid,
                tokenIds: entry.tokenIds,
                ...(typeof entry.memo === 'string'
                  ? { memo: entry.memo }
                  : {}),
              },
            );
            return;
          }
          case 'txf-legacy': {
            throw new SphereError(
              `SendingRecoveryWorker default republish cannot recover entry ${entry.id}: ` +
                `deliveryMethod='txf-legacy' is a single-token legacy wire shape that does ` +
                `not round-trip through the UXF payload union. Operator triage required.`,
              'VALIDATION_ERROR',
            );
          }
          default: {
            // Defense-in-depth: refuse to publish an unknown
            // delivery method as `'uxf-cid'` blindly. This branch
            // is unreachable today; if a new arm is added to
            // `UxfTransferOutboxEntry.deliveryMethod` and lands in
            // the outbox before this switch is updated, fail-closed.
            const _exhaustive: never = entry.deliveryMethod;
            throw new SphereError(
              `SendingRecoveryWorker default republish: unsupported ` +
                `deliveryMethod=${String(_exhaustive)} on entry ${entry.id}`,
              'VALIDATION_ERROR',
            );
          }
        }
      },
      emit: sphereEmit,
    };
    const worker = new SendingRecoveryWorker(recoveryDeps);
    host.setSendingRecoveryWorker(worker);
    worker.start();
    logger.debug(
      'Payments',
      'Default SendingRecoveryWorker auto-installed (recoveryWorker default-on)',
    );
  } else if (
    host.features.recoveryWorker &&
    host.getSendingRecoveryWorker() !== null
  ) {
    // Pre-installed by the bootstrap layer — start it.
    host.getSendingRecoveryWorker()!.start();
  }

  // Issue #166 P2 #4 — auto-install the SENT-write reconciliation
  // worker. Mirrors the SendingRecoveryWorker pattern above but with
  // closures over the OUTBOX/SENT writer providers so the worker
  // observes hot-swaps and the writer-uninstall arc at destroy. The
  // worker itself self-skips when either writer is null, so the
  // start() call is safe even before the bootstrap layer (Sphere)
  // installs the writers.
  if (
    host.features.sentReconciliationWorker &&
    host.getSentReconciliationWorker() === null
  ) {
    // Pre-bind the SENT-write helper so the closure in
    // `recDeps.writeSentEntry` doesn't lose `this` — same rationale
    // as the SendingRecoveryWorker's C3 fix above.
    const writeSentEntryFromOutbox = host.writeSentEntryFromOutbox.bind(host);
    const recDeps: SentReconciliationWorkerDeps = {
      outboxProvider: (): Pick<OutboxWriter, 'readAllNew' | 'delete'> | null =>
        host.getOutboxWriter(),
      sentProvider: (): Pick<SentLedgerWriter, 'readOne'> | null =>
        host.getSentLedgerWriter(),
      writeSentEntry: writeSentEntryFromOutbox,
      emit: host.deps.emitEvent,
    };
    const worker = new SentReconciliationWorker(recDeps);
    host.setSentReconciliationWorker(worker);
    worker.start();
    logger.debug(
      'Payments',
      'Default SentReconciliationWorker auto-installed (sentReconciliationWorker default-on)',
    );
  } else if (
    host.features.sentReconciliationWorker &&
    host.getSentReconciliationWorker() !== null
  ) {
    // Pre-installed by the bootstrap layer — start it.
    host.getSentReconciliationWorker()!.start();
  }

  // Issue #166 P2 #3 — auto-install the Nostr persistence
  // verification worker. Mirrors the recovery / reconciliation
  // worker patterns above. Default-ON after item #5 soak; the
  // worker self-skips entries that lack `nostrEventId` (legacy
  // SENT entries from before the dispatcher capture wiring), and
  // routes verify() through transport.verifyTokenTransferRetained
  // when the transport implements it (else 'unverifiable' which
  // never produces a false-positive warning).
  if (
    host.features.nostrPersistenceVerifier &&
    host.getNostrPersistenceVerifier() === null
  ) {
    const transport = host.deps.transport;
    const sphereEmit = host.deps.emitEvent;
    const verifierDeps: NostrPersistenceVerifierDeps = {
      sentProvider: (): Pick<SentLedgerWriter, 'readAll'> | null =>
        host.getSentLedgerWriter(),
      // OUTBOX-SEND-FOLLOWUPS item #2 — thread the OUTBOX writer so
      // the verifier can transition live `delivered`/`delivered-
      // instant` entries back to `'sending'` on retention drops.
      // The SendingRecoveryWorker then republishes via its existing
      // scan loop (item #6's deliveryMethod-aware closure handles
      // CAR/TXF entries safely).
      outboxProvider: (): Pick<OutboxWriter, 'update'> | null =>
        host.getOutboxWriter(),
      verify: async (entry: UxfSentLedgerEntry): Promise<VerifyOutcome> => {
        if (
          typeof entry.nostrEventId !== 'string' ||
          entry.nostrEventId.length === 0
        ) {
          return 'unverifiable';
        }
        if (typeof transport.verifyTokenTransferRetained !== 'function') {
          // Transport does not implement the optional verify
          // method — the worker can't make progress here, but
          // 'unverifiable' means "retry next cycle" so no false
          // warnings are emitted.
          return 'unverifiable';
        }
        try {
          return await transport.verifyTokenTransferRetained(
            entry.nostrEventId,
          );
        } catch {
          // The transport contract says "never throw," but
          // defense-in-depth: a throw here degrades to
          // unverifiable rather than missing.
          return 'unverifiable';
        }
      },
      emit: sphereEmit,
    };
    const verifier = new NostrPersistenceVerifier(verifierDeps);
    host.setNostrPersistenceVerifier(verifier);
    verifier.start();
    logger.debug(
      'Payments',
      'Default NostrPersistenceVerifier auto-installed (nostrPersistenceVerifier opt-in flag ON)',
    );
  } else if (
    host.features.nostrPersistenceVerifier &&
    host.getNostrPersistenceVerifier() !== null
  ) {
    host.getNostrPersistenceVerifier()!.start();
  }

  // Issue #174 — auto-install the per-token spent-state rescan worker
  // (UXF-TRANSFER-PROTOCOL §12.3.2). Default-OFF; when ON the worker
  // probes oracle.isSpent for each `'confirmed'` token to detect
  // off-record spends from sibling instances of the same wallet.
  // `transitionToAudit` defaults to {@link defaultSpentStateTransition}
  // (local Token.status flip + archive + tombstone via removeToken);
  // callers that need to route through a production-wired
  // `DispositionWriter.write()` (future, once that wiring lands in
  // production) override via {@link setSpentStateRescanTransitionToAudit}.
  // The `oracleProvider` closure reads `this.deps?.oracle` lazily so
  // a future `deps` re-init (e.g. oracle swap on reconnect) is
  // observed; same closure pattern as `sentProvider` / `outboxProvider`
  // for consistency.
  if (
    host.features.spentStateRescan &&
    host.getSpentStateRescanWorker() === null
  ) {
    const sphereEmit = host.deps.emitEvent;
    const rescanDeps: SpentStateRescanWorkerDeps = {
      tokensProvider: (): Iterable<Token> => host.getTokensIterable(),
      oracleProvider: (): {
        readonly isSpent: (token: Token, stateHash: string) => Promise<boolean>;
      } | null => {
        // Issue #243 / #245 #1 — wallet-scoped wrapper around
        // oracle.isSpent. The underlying OracleProvider.isSpent
        // requires `(publicKey, stateHash)` because the canonical
        // aggregator indexes commitments by
        // `RequestId.create(pubkey, hash)`.
        //
        // Per-token publicKey extraction: parse the token's CURRENT
        // state predicate from `sdkData` and use ITS publicKey,
        // falling back to `chainPubkey` on parse failure. Binding
        // `chainPubkey` for every token misses spent states whose
        // predicate was constructed under a different key (sync
        // race / migration data / multi-address wallets where the
        // worker scans address A's pool but a token's predicate
        // was built under address B).
        const oracle = host.deps.oracle;
        if (oracle === undefined || typeof oracle.isSpent !== 'function') {
          return null;
        }
        const fallbackPubkey = host.getFallbackChainPubkey();
        if (!fallbackPubkey) return null;
        return {
          isSpent: async (token: Token, stateHash: string): Promise<boolean> => {
            const ownerPubkey =
              (await host.extractCurrentStatePublicKeyHexFromSdkData(token.sdkData)) ??
              fallbackPubkey;
            return oracle.isSpent(ownerPubkey, stateHash);
          },
        };
      },
      extractCurrentStateHash: (token: Token): string =>
        host.extractCurrentStateHash(token),
      sentProvider: (): Pick<SentLedgerWriter, 'contains'> | null =>
        host.getSentLedgerWriter(),
      outboxProvider: (): Pick<OutboxWriter, 'readAll'> | null =>
        host.getOutboxWriter(),
      transitionToAudit:
        host.getSpentStateRescanTransitionToAudit() ??
        host.defaultSpentStateTransition,
      emit: sphereEmit,
      logger: {
        warn: (message: string, context?: Record<string, unknown>): void => {
          logger.warn('Payments', `${message}`, context);
        },
      },
    };
    const worker = new SpentStateRescanWorker(rescanDeps);
    host.setSpentStateRescanWorker(worker);
    worker.start();
    logger.debug(
      'Payments',
      'Default SpentStateRescanWorker auto-installed (spentStateRescan opt-in flag ON)',
    );
  } else if (
    host.features.spentStateRescan &&
    host.getSpentStateRescanWorker() !== null
  ) {
    host.getSpentStateRescanWorker()!.start();
  }

  // OUTBOX-SEND-FOLLOWUPS item #4 — auto-install the tombstone GC
  // worker. Default-ON after item #5 soak: the worker periodically
  // reclaims storage occupied by tombstones whose retention window
  // has elapsed. Both writers self-skip when no writer is installed,
  // so the start() call is safe even before bootstrap installs them.
  if (
    host.features.tombstoneGcWorker &&
    host.getTombstoneGcWorker() === null
  ) {
    const gcDeps: TombstoneGcWorkerDeps = {
      outboxProvider: (): Pick<OutboxWriter, 'gcExpiredTombstones'> | null =>
        host.getOutboxWriter(),
      sentProvider: (): Pick<SentLedgerWriter, 'gcExpiredTombstones'> | null =>
        host.getSentLedgerWriter(),
      logger: {
        warn: (message: string, context?: Record<string, unknown>): void => {
          logger.warn('Payments', `${message}`, context);
        },
      },
    };
    const worker = new TombstoneGcWorker(gcDeps);
    host.setTombstoneGcWorker(worker);
    worker.start();
    logger.debug(
      'Payments',
      'Default TombstoneGcWorker auto-installed (tombstoneGcWorker opt-in flag ON)',
    );
  } else if (
    host.features.tombstoneGcWorker &&
    host.getTombstoneGcWorker() !== null
  ) {
    host.getTombstoneGcWorker()!.start();
  }
}

// =============================================================================
// Finalization stack block: AbortController + sharedPerTokenMutex +
// FinalizationWorkerSender + FinalizationWorkerRecipient +
// InclusionProofImporter + RevalidateCascadedRunner
// =============================================================================

/**
 * Install the "finalization stack" auto-install fleet block. Runs
 * AFTER the facade's IngestWorkerPool block.
 *
 * Behaviour-preserving move of PaymentsModule.ts initialize() lines
 * ~2978–~3229 (AbortController through RevalidateCascadedRunner).
 */
export function installUxfFinalizationStack(host: UxfWorkerFleetHost): void {
  // Task #169 — Per-initialize AbortController. Aborted in destroy()
  // BEFORE awaiting worker.stop() so in-flight runFinalizationCycle
  // invocations + their pending sleep(...) timers terminate
  // deterministically. Recreated each initialize() because aborted
  // signals cannot be reset.
  host.setWorkerAbortController(new AbortController());

  // Round 7 (FIX 3) — Shared per-tokenId mutex. Constructed once per
  // initialize() and plumbed into the sender + recipient finalization
  // workers AND the operator escape-hatch InclusionProofImporter so
  // all three paths serialize against the same read-decide-write
  // window when they touch the same tokenId. Without this, a
  // concurrent `finalizeTransferToken(X)` and `importInclusionProof(X)`
  // race in their respective per-tokenId guards (each builder
  // previously created its own fresh PerTokenMutex), corrupting the
  // manifest's audit trail or re-queuing duplicate K-1 entries.
  host.setSharedPerTokenMutex(new PerTokenMutex());

  // Phase 9.6.D — auto-install the sender-side finalization worker when
  // `senderUxf` is on AND `finalizationWorker` is on AND no consumer has
  // already installed one via `installFinalizationWorkerSender()`.
  //
  // The auto-installed worker uses lightweight in-memory adapters for the
  // pool/manifest/tombstone/queue 4-step write order (no OrbitDB required).
  // These in-memory writes are sufficient to drive the §6.1 cycle to
  // completion and emit `transfer:confirmed`. The full OrbitDB-backed
  // adapters can be injected by the bootstrap layer (Sphere) via
  // `installFinalizationWorkerSender()` when it has the full profile stack.
  //
  // Consumer-installed workers (installFinalizationWorkerSender()) win:
  // the `!this.finalizationWorkerSender` check preserves that contract.
  if (
    host.features.senderUxf &&
    host.features.finalizationWorker &&
    !host.getFinalizationWorkerSender()
  ) {
    const aggregatorClient = host.deps.oracle.getAggregatorClient?.();
    if (aggregatorClient === null || aggregatorClient === undefined) {
      // Oracle stub does not expose an aggregator client; skip auto-install.
      // Tests with mocked oracles (no getAggregatorClient) take this path.
      logger.debug(
        'Payments',
        'FinalizationWorkerSender auto-install skipped: oracle has no getAggregatorClient()',
      );
    } else {
      const directAddr = host.deps.identity.directAddress;
      const workerAddressId =
        typeof directAddr === 'string' && directAddr.length > 0
          ? computeAddressId(directAddr)
          : host.deps.identity.chainPubkey;
      const worker = buildDefaultFinalizationWorkerSender({
        addressId: workerAddressId,
        oracle: host.deps.oracle,
        senderOutboxMap: host.senderOutboxMap,
        senderRequestContextMap: host.senderRequestContextMap,
        emit: (type, data) => host.deps.emitEvent(type, data),
        // Task #169 — wire the per-initialize AbortController's signal
        // through to the worker so destroy() can cancel in-flight
        // submit/poll cycles + sleep timers.
        signal: host.getWorkerAbortController()!.signal,
        // Round 7 (FIX 3) — share per-tokenId mutex with recipient
        // worker + operator importer so all three paths serialize
        // against the same read-decide-write window.
        perTokenMutex: host.getSharedPerTokenMutex(),
      });
      host.setFinalizationWorkerSender(worker);
      worker.start();
      logger.debug(
        'Payments',
        'Default FinalizationWorkerSender auto-installed (senderUxf default-on)',
      );
    }
  }

  // Task #151 — auto-install the recipient-side finalization worker
  // when `recipientUxf` is on AND `finalizationWorker` is on AND no
  // consumer has already installed one via
  // `installFinalizationWorkerRecipient()`.
  //
  // The auto-installed worker uses lightweight in-memory adapters
  // (FinalizationQueue + manifestCas + tombstones + pool + queue +
  // stub revaluateHooks/cascadeWalker). Its dispositionWriter is
  // wired back to PaymentsModule via the
  // `_recipientFinalizationContext` map: when the worker writes a
  // VALID disposition for a tokenId, PaymentsModule rebuilds the SDK
  // Token via `finalizeTransferToken` and overwrites the locally-
  // stored Token's sdkData + flips status to 'confirmed'.
  //
  // This is the minimum production-ready harness that closes the
  // S2 e2e loop (Bob receives instant tokens → re-spends them).
  // Bootstrap layers (Sphere) MAY override via
  // `installFinalizationWorkerRecipient()` for a full §5.5 / §6.2
  // implementation backed by Profile + OrbitDB.
  //
  // FIXME(#151): the in-memory queue + finalization context map are
  // NOT persisted across `Sphere.destroy()` and process restart.
  // Recovery on next launch requires either a manifest scan or an
  // external re-trigger (operator escape-hatch). The Profile-backed
  // FinalizationQueue (T.5.C / Wave G.7) deferred to a future wave
  // closes this gap.
  if (
    host.features.recipientUxf &&
    host.features.finalizationWorker &&
    !host.getFinalizationWorkerRecipient()
  ) {
    const aggregatorClient = host.deps.oracle.getAggregatorClient?.();
    if (aggregatorClient === null || aggregatorClient === undefined) {
      logger.debug(
        'Payments',
        'FinalizationWorkerRecipient auto-install skipped: oracle has no getAggregatorClient()',
      );
    } else {
      const directAddr = host.deps.identity.directAddress;
      const recipientAddressId =
        typeof directAddr === 'string' && directAddr.length > 0
          ? computeAddressId(directAddr)
          : host.deps.identity.chainPubkey;

      // G7 — re-hydrate the recipient context Maps from persisted
      // storage. Without this, a Sphere that crashed between enqueue
      // and finalization could not surface the contexts the
      // dispositionWriter VALID branch needs to flip local Tokens to
      // `'confirmed'`.
      //
      // The hydration is fire-and-forget so initialize() stays
      // synchronous; the recipient worker has its own retry loop and
      // is tolerant of a context Map populated mid-cycle. The hydration
      // promise is exposed via {@link awaitRecipientContextHydration}
      // for tests that need a deterministic settle point.
      if (host.getRecipientContextStorage() !== null) {
        const ctxStorage = host.getRecipientContextStorage()!;
        host.setRecipientContextHydrationPromise((async () => {
          try {
            const persistedFinalization =
              await ctxStorage.listAllFinalizationContexts(recipientAddressId);
            for (const [tokenId, ctx] of persistedFinalization) {
              if (!host.recipientFinalizationContext.has(tokenId)) {
                host.recipientFinalizationContext.set(tokenId, ctx);
              }
            }
            const persistedRequest =
              await ctxStorage.listAllRequestContexts(recipientAddressId);
            for (const [reqId, ctx] of persistedRequest) {
              if (!host.recipientRequestContextMap.has(reqId)) {
                // Cast: PersistedRequestContext is the JSON-safe
                // mirror of RequestContext (`nextEntryRest` widens to
                // Record<string, unknown> at the storage layer).
                host.recipientRequestContextMap.set(
                  reqId,
                  ctx as unknown as RequestContext,
                );
              }
            }
            logger.debug(
              'Payments',
              `G7: re-hydrated ${persistedFinalization.size} finalization + ${persistedRequest.size} request contexts from profile`,
            );
          } catch (err) {
            logger.warn(
              'Payments',
              `G7: failed to re-hydrate recipient context Maps from profile (continuing with empty maps): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })());
      }

      const built = buildDefaultFinalizationWorkerRecipient({
        addressId: recipientAddressId,
        oracle: host.deps.oracle,
        recipientRequestContextMap: host.recipientRequestContextMap,
        recipientFinalizationContext: host.recipientFinalizationContext,
        tokens: host.tokens,
        finalizeTransferToken: (sourceToken, lastTx, stClient, trustBase) =>
          host.finalizeTransferToken(sourceToken, lastTx, stClient, trustBase),
        getStateTransitionClient: () =>
          host.deps.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        getTrustBase: () => (host.deps.oracle as any).getTrustBase?.(),
        save: () => host.save(),
        emit: (type, data) => host.deps.emitEvent(type, data),
        signal: host.getWorkerAbortController()!.signal,
        // Round 7 (FIX 3) — share per-tokenId mutex with sender worker
        // + operator importer so all three paths serialize against the
        // same read-decide-write window.
        perTokenMutex: host.getSharedPerTokenMutex(),
        // G3 — pass the Profile-backed persisted FinalizationQueueStorage
        // when configured. When null, the helper falls back to the
        // in-memory shim (legacy behavior).
        finalizationQueueStorage:
          host.getRecipientFinalizationQueueStorage() ?? undefined,
      });
      host.setRecipientFinalizationQueue(built.queue);
      host.setFinalizationWorkerRecipient(built.worker);
      // Wave 7 hygiene: retain the streak-cleanup callback so destroy()
      // can wipe the closure-local `saveFailureStreak` Map alongside
      // the other context maps.
      host.setRecipientSaveFailureStreakClear(built.clearSaveFailureStreak);
      built.worker.start();
      logger.debug(
        'Payments',
        'Default FinalizationWorkerRecipient auto-installed (recipientUxf default-on)',
      );
    }
  }

  // Round 5 (FIX 1) — auto-install the operator escape-hatch importer
  // and revalidate-cascaded runner (T.5.D). Before Round 5, no
  // production code path called `installInclusionProofImporter()` /
  // `installRevalidateCascadedRunner()`, so every wallet that
  // bootstrapped through `Sphere.init()` threw
  // `OPERATOR_ESCAPE_HATCH_NOT_CONFIGURED` on the first
  // `payments.importInclusionProof()` / `payments.revalidateCascadedChildren()`
  // call.
  //
  // The auto-installed defaults use lightweight in-memory adapters
  // (mirroring `buildDefaultFinalizationWorkerSender`'s pattern):
  //  - `InMemoryDispositionStorageAdapter` for `_invalid` / `_audit`
  //  - In-memory `MinimalManifestStorage` + a fresh `ManifestStore`
  //    bound to a fresh `Lamport` clock
  //  - Stub `queueScanner` (returns no entries) and stub
  //    `verifyProof` (returns `'NOT_AUTHENTICATED'`) so the importer
  //    fails closed on every operator-supplied proof until the
  //    bootstrap layer overrides
  //
  // Bootstrap layers (Sphere) MAY override either by calling
  // `installInclusionProofImporter()` / `installRevalidateCascadedRunner()`
  // BEFORE `initialize()` (the `!this.inclusionProofImporter` checks
  // preserve that contract) or AFTER `initialize()` (the install
  // methods replace the auto-installed instance). Production
  // override should construct an `OrbitDbDispositionStorageAdapter`
  // bound to the wallet's ProfileDatabase and an OrbitDB-backed
  // ManifestStore — see `OrbitDbDispositionStorageAdapter` JSDoc for
  // the wiring sketch.
  if (host.getInclusionProofImporter() === null) {
    host.setInclusionProofImporter(buildDefaultInclusionProofImporter({
      emit: (type, data) => host.deps.emitEvent(type, data),
      // Round 7 (FIX 3) — share per-tokenId mutex with finalization
      // workers so concurrent finalize + operator import on the same
      // tokenId serialize against the read-decide-write window.
      perTokenMutex: host.getSharedPerTokenMutex() ?? undefined,
    }));
    logger.debug(
      'Payments',
      'Default InclusionProofImporter auto-installed (in-memory disposition storage)',
    );
  }
  if (host.getRevalidateCascadedRunner() === null) {
    host.setRevalidateCascadedRunner(buildDefaultRevalidateCascadedRunner());
    logger.debug(
      'Payments',
      'Default RevalidateCascadedRunner auto-installed (in-memory manifest scanner)',
    );
  }
}
