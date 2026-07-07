/**
 * @internal Phase 5 [C] quarantine — Phase 6.C deletes this file wholesale.
 * NOSTR-FIRST proof-polling machinery.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Token } from '../../../types';
import { logger } from '../../../core/logger';
import { SphereError } from '../../../core/errors';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';
import { CidRefStore } from '../../../extensions/uxf/profile/cid-ref-store';
import {
  extractTokenIdFromSdkData,
  extractStateHashFromSdkData,
} from '../tokens';
import { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId';
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';

/**
 * Job for background proof polling (NOSTR-FIRST pattern).
 * Re-exported from PaymentsModule.ts as `ProofPollingJob` for external
 * test compatibility.
 */
export interface ProofPollingJob {
  tokenId: string;
  requestIdHex: string;
  commitmentJson: string;
  sourceTokenJson?: string;
  startedAt: number;
  attemptCount: number;
  lastAttemptAt: number;
  cumulativeAttempts?: number;
  onProofReceived?: (tokenId: string) => void;
}

export interface PersistedProofPollingJob {
  genesisTokenId: string;
  stateHash: string;
  requestIdHex: string;
  commitmentJson: string;
  sourceTokenJson: string;
  startedAt: number;
  attemptCount: number;
  lastAttemptAt: number;
  cumulativeAttempts?: number;
}

export async function submitAndPollForProofImpl(this: any, 
    tokenId: string,
    commitment: TransferCommitment,
    requestIdHex: string,
    onProofReceived?: (tokenId: string) => void
  ): Promise<void> {
    try {
      // Submit to aggregator
      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      if (!stClient) {
        logger.debug('Payments', 'Cannot submit commitment - no state transition client');
        return;
      }

      const response = await stClient.submitTransferCommitment(commitment);
      if (response.status !== 'SUCCESS' && response.status !== 'REQUEST_ID_EXISTS') {
        logger.debug('Payments', `Transfer commitment submission failed: ${response.status}`);
        // Mark token as invalid since submission failed
        const token = this.tokens.get(tokenId);
        if (token) {
          token.status = 'invalid';
          token.updatedAt = Date.now();
          this.tokens.set(tokenId, token);
          await this.save();
        }
        return;
      }

      // Add to polling queue
      this.addProofPollingJob({
        tokenId,
        requestIdHex,
        commitmentJson: JSON.stringify(commitment.toJSON()),
        startedAt: Date.now(),
        attemptCount: 0,
        lastAttemptAt: 0,
        onProofReceived,
      });
    } catch (error) {
      logger.debug('Payments', 'submitAndPollForProof error:', error);
    }
}

export function addProofPollingJobImpl(this: any, job: ProofPollingJob): void {
    this.proofPollingJobs.set(job.tokenId, job);
    logger.debug('Payments', `Added proof polling job for token ${job.tokenId.slice(0, 8)}...`);
    this.startProofPolling();
    // Persist for restart recovery (#144 L1). Fire-and-forget — the job is
    // already in-memory, so a persist failure only affects restart recovery.
    if (job.sourceTokenJson) {
      this.saveProofPollingJobs().catch((err: unknown) =>
        logger.debug('Payments', '[V6-PERSIST] saveProofPollingJobs after add failed:', err)
      );
    }
}

export async function saveProofPollingJobsImpl(this: any): Promise<void> {
    const persisted: PersistedProofPollingJob[] = [];
    for (const [tokenId, job] of this.proofPollingJobs) {
      if (!job.sourceTokenJson) continue;
      const token = this.tokens.get(tokenId);
      // Token may be absent if the job was just added in this tick and the
      // map mutated concurrently. Use the job's stored sdkData as the
      // canonical source of genesis+state info — it's the same value that
      // was written to `Token.sdkData` at create time.
      const sourceTokenJson = job.sourceTokenJson;
      const genesisTokenId = token
        ? extractTokenIdFromSdkData(token.sdkData)
        : extractTokenIdFromSdkData(sourceTokenJson);
      const stateHash = token
        ? extractStateHashFromSdkData(token.sdkData)
        : extractStateHashFromSdkData(sourceTokenJson);
      if (!genesisTokenId || !stateHash) {
        logger.debug(
          'Payments',
          `[V6-PERSIST] Skipping job for ${tokenId.slice(0, 12)} — missing genesisTokenId or stateHash`
        );
        continue;
      }
      persisted.push({
        genesisTokenId,
        stateHash,
        requestIdHex: job.requestIdHex,
        commitmentJson: job.commitmentJson,
        sourceTokenJson,
        startedAt: job.startedAt,
        attemptCount: job.attemptCount,
        lastAttemptAt: job.lastAttemptAt,
        // Steelman FIX G (#144): persist cumulative attempts across
        // process lifetimes. The session's current `attemptCount` is
        // ADDED to the previously-persisted total at restore time, so
        // we save the running total here (= prior + current).
        cumulativeAttempts: (job.cumulativeAttempts ?? 0) + job.attemptCount,
      });
    }

    if (persisted.length === 0) {
      // Clear the KV entry when no eligible jobs remain. Use storage.remove
      // when available so a stale list doesn't survive.
      const storage = this.deps!.storage;
      const removeFn = (storage as { remove?: (k: string) => Promise<void> }).remove;
      if (typeof removeFn === 'function') {
        await removeFn.call(storage, STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS);
      } else {
        await this.setStorageEntry(
          STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS,
          '[]',
          'cache_index'
        );
      }
      return;
    }

    await this.setStorageEntry(
      STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS,
      JSON.stringify(persisted),
      'cache_index'
    );
}

export async function restoreProofPollingJobsImpl(this: any): Promise<void> {
    const data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.PROOF_POLLING_JOBS);
    if (!data) return;

    let persisted: PersistedProofPollingJob[];
    try {
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) {
        logger.error('Payments', '[V6-RESTORE] Persisted jobs is not an array; clearing');
        return;
      }
      persisted = parsed as PersistedProofPollingJob[];
    } catch (err) {
      logger.error('Payments', '[V6-RESTORE] Failed to parse persisted jobs:', err);
      return;
    }

    if (persisted.length === 0) return;

    let restored = 0;
    for (const p of persisted) {
      if (
        !p.genesisTokenId ||
        !p.stateHash ||
        !p.requestIdHex ||
        !p.commitmentJson ||
        !p.sourceTokenJson
      ) {
        logger.debug('Payments', '[V6-RESTORE] Skipping malformed persisted job');
        continue;
      }

      // Find matching in-memory token by genesis tokenId + state hash.
      let memoryTokenId: string | null = null;
      for (const [id, token] of this.tokens) {
        const tid = extractTokenIdFromSdkData(token.sdkData);
        const sh = extractStateHashFromSdkData(token.sdkData);
        if (tid === p.genesisTokenId && sh === p.stateHash) {
          memoryTokenId = id;
          break;
        }
      }
      if (!memoryTokenId) {
        logger.debug(
          'Payments',
          `[V6-RESTORE] No matching token for job ` +
            `(genesisTokenId=${p.genesisTokenId.slice(0, 12)}, ` +
            `stateHash=${p.stateHash.slice(0, 12)}), dropping`
        );
        continue;
      }

      // Already finalized in a prior session? Skip.
      const existingToken = this.tokens.get(memoryTokenId);
      if (existingToken && existingToken.status === 'confirmed') {
        logger.debug(
          'Payments',
          `[V6-RESTORE] Token ${memoryTokenId.slice(0, 12)} already confirmed, skipping job`
        );
        continue;
      }

      // Issue #389 finding #6 — V6-RECOVER permanent ledger short-circuit.
      // With the new load() ordering, `restoreV6RecoverPermanent` ran
      // before this method, so the ledger is hydrated and we can skip
      // job re-registration for any token whose canonical id was
      // permanently rejected. Without this guard, the job would be
      // re-registered, fire on the next proof, hit the
      // `finalizeReceivedToken` ledger guard, and no-op — wasted work
      // but not incorrect. The early skip here keeps load() O(restored)
      // instead of O(restored + permanent).
      if (existingToken && this.isV6RecoverPermanentToken(existingToken, memoryTokenId)) {
        logger.debug(
          'Payments',
          `[V6-RESTORE] Token ${memoryTokenId.slice(0, 12)} on permanent-verdict ledger, skipping job`,
        );
        continue;
      }

      // Steelman FIX G (#144): cumulative-attempts cap. If this token
      // has already burned through MAX_CUMULATIVE_ATTEMPTS across
      // prior process lifetimes, mark it invalid and skip restoration.
      // Without this cap, every restart hands the same stuck token a
      // fresh 60s budget — an unbounded zombie loop.
      const cumulativeSoFar = p.cumulativeAttempts ?? 0;
      if (cumulativeSoFar >= (this.constructor as any).PROOF_POLLING_MAX_CUMULATIVE_ATTEMPTS) {
        logger.debug(
          'Payments',
          `[V6-RESTORE] Token ${memoryTokenId.slice(0, 12)} ` +
            `exceeded cumulative attempt cap (${cumulativeSoFar} >= ` +
            `${(this.constructor as any).PROOF_POLLING_MAX_CUMULATIVE_ATTEMPTS}) — marking invalid`,
        );
        if (existingToken && (existingToken.status === 'submitted' || existingToken.status === 'pending')) {
          existingToken.status = 'invalid';
          existingToken.updatedAt = Date.now();
          this.tokens.set(memoryTokenId, existingToken);
        }
        try {
          this.deps!.emitEvent('transfer:operator-alert', {
            // Same canonical reason as per-process timeout — the
            // proof never anchored after multiple polling windows.
            code: 'oracle-rejected',
            tokenId: memoryTokenId,
            message:
              `Token ${memoryTokenId.slice(0, 12)}... exceeded cumulative ` +
              `proof-polling attempts (${cumulativeSoFar}). Marked invalid; ` +
              `no further automatic recovery attempts will run for this token.`,
          });
        } catch { /* event emitter not wired */ }
        continue;
      }

      let sourceTokenInput: unknown;
      let commitmentInput: unknown;
      try {
        sourceTokenInput = JSON.parse(p.sourceTokenJson);
        commitmentInput = JSON.parse(p.commitmentJson);
      } catch (err) {
        logger.error(
          'Payments',
          `[V6-RESTORE] Failed to parse source/commitment for ${p.genesisTokenId.slice(0, 12)}:`,
          err
        );
        continue;
      }

      this.proofPollingJobs.set(memoryTokenId, {
        tokenId: memoryTokenId,
        requestIdHex: p.requestIdHex,
        commitmentJson: p.commitmentJson,
        sourceTokenJson: p.sourceTokenJson,
        startedAt: p.startedAt,
        attemptCount: 0, // reset for the current session
        lastAttemptAt: 0,
        cumulativeAttempts: cumulativeSoFar, // preserve cross-session total
        onProofReceived: async (tid: string) => {
          await this.finalizeReceivedToken(tid, sourceTokenInput, commitmentInput);
        },
      });
      restored++;
    }

    if (restored > 0) {
      logger.debug(
        'Payments',
        `[V6-RESTORE] Restored ${restored} proof-polling job(s) from storage`
      );
      this.startProofPolling();
    }
}

export function startProofPollingImpl(this: any): void {
    if (this.proofPollingInterval) return;
    if (this.proofPollingJobs.size === 0) return;

    logger.debug('Payments', 'Starting proof polling...');
    this.proofPollingInterval = setInterval(
      () => this.processProofPollingQueue(),
      (this.constructor as any).PROOF_POLLING_INTERVAL_MS
    );
}

export function stopProofPollingImpl(this: any): void {
    if (this.proofPollingInterval) {
      clearInterval(this.proofPollingInterval);
      this.proofPollingInterval = null;
      logger.debug('Payments', 'Stopped proof polling');
    }
}

export async function processProofPollingQueueImpl(this: any): Promise<void> {
    if (this.proofPollingJobs.size === 0) {
      this.stopProofPolling();
      return;
    }

    const completedJobs: string[] = [];

    for (const [tokenId, job] of this.proofPollingJobs) {
      try {
        job.attemptCount++;
        job.lastAttemptAt = Date.now();

        // Check for timeout
        if (job.attemptCount >= (this.constructor as any).PROOF_POLLING_MAX_ATTEMPTS) {
          logger.debug('Payments', `Proof polling timeout for token ${tokenId.slice(0, 8)}...`);
          // Mark token as invalid due to timeout.
          // Steelman FIX C (#144): widen to include 'pending' — RECEIVE
          // jobs target status='pending' tokens, and pre-fix the timeout
          // never marked them invalid, leaving them at 'pending' forever
          // and re-triggering `recoverStrandedReceivedTokens` on every
          // load (zombie loop).
          const token = this.tokens.get(tokenId);
          if (token && (token.status === 'submitted' || token.status === 'pending')) {
            token.status = 'invalid';
            token.updatedAt = Date.now();
            this.tokens.set(tokenId, token);
            // Surface to operator/UI: the token's proof never arrived.
            // Without this, the only signal is a debug-level log line.
            try {
              this.deps!.emitEvent('transfer:operator-alert', {
                // `oracle-rejected` per §6.1: "sustained PATH_NOT_INCLUDED
                // past the polling window — the commitment was never
                // anchored". Closest canonical reason for proof-polling
                // timeout exhaustion.
                code: 'oracle-rejected',
                tokenId,
                message:
                  `Proof polling for token ${tokenId.slice(0, 12)}... ` +
                  `exhausted ${(this.constructor as any).PROOF_POLLING_MAX_ATTEMPTS} attempts ` +
                  `(~${((this.constructor as any).PROOF_POLLING_MAX_ATTEMPTS * (this.constructor as any).PROOF_POLLING_INTERVAL_MS) / 1000}s). ` +
                  `Marked invalid; the aggregator never returned an inclusion proof. ` +
                  `Manual retry via sphere.payments.sync() may help if the proof becomes available later.`,
              });
            } catch {
              // Event emitter not wired or threw — log only.
            }
          }
          completedJobs.push(tokenId);
          continue;
        }

        // Try to get proof with a quick timeout (non-blocking check).
        //
        // #144 L3: jobs registered via `recoverStrandedReceivedTokens`
        // have an empty `commitmentJson` (we can't reconstruct the
        // sender's authenticator). For those, fall back to the
        // `getProof(requestIdHex)` path directly — no commitment needed.
        let inclusionProof: unknown = null;
        try {
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), 500);

          if (job.commitmentJson && this.deps!.oracle.waitForProofSdk) {
            const commitment = await TransferCommitment.fromJSON(JSON.parse(job.commitmentJson));
            inclusionProof = await Promise.race([
              this.deps!.oracle.waitForProofSdk(commitment, abortController.signal),
              new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
            ]);
          } else {
            // Fallback: use getProof with request ID hex (also the only
            // path for #144 L3 migration jobs).
            const proof = await this.deps!.oracle.getProof(job.requestIdHex);
            if (proof) {
              inclusionProof = proof;
            }
          }

          clearTimeout(timeoutId);
        } catch (_err) {
          // Proof not ready yet or timed out
          continue;
        }

        if (!inclusionProof) {
          // Proof not ready yet
          continue;
        }

        // Proof received! Steelman FIX B (#144): distinguish SEND vs
        // RECEIVE jobs.
        //   - SEND jobs (no `sourceTokenJson`): the sender's outbound
        //     commitment was confirmed → flip token to 'spent' here.
        //   - RECEIVE jobs (`sourceTokenJson` set — V6-direct or L3
        //     migration): leave status='pending' and let
        //     `onProofReceived` (`finalizeReceivedToken` /
        //     `finalizeStrandedReceivedToken`) be the SOLE status
        //     writer. If `onProofReceived` throws, the token stays
        //     'pending' so the next tick (or next process's
        //     recoverStrandedReceivedTokens) can retry. Without this
        //     guard, a finalize throw would permanently freeze the token
        //     at 'spent' — un-recoverable, because
        //     `recoverStrandedReceivedTokens` requires status='pending'.
        const token = this.tokens.get(tokenId);
        const isReceiveJob = !!job.sourceTokenJson;
        if (token && !isReceiveJob) {
          token.status = 'spent';
          token.updatedAt = Date.now();
          this.tokens.set(tokenId, token);
          await this.save();
          logger.debug('Payments', `Proof received for token ${tokenId.slice(0, 8)}..., status: spent`);
        }

        // Await the finalize callback so a throw is observable; on
        // success the queue removes the job, on failure the job stays
        // for retry. (Pre-FIX-B: callback was fire-and-forget AND the
        // job was unconditionally removed via completedJobs.push — both
        // bugs, both fixed here.)
        let callbackOk = true;
        try {
          await job.onProofReceived?.(tokenId);
        } catch (cbErr) {
          callbackOk = false;
          logger.error(
            'Payments',
            `onProofReceived for ${tokenId.slice(0, 8)}... threw — keeping job for retry:`,
            cbErr,
          );
        }
        if (callbackOk) {
          completedJobs.push(tokenId);
        }
      } catch (error) {
        // Most errors mean proof is not ready yet, continue polling
        logger.debug('Payments', `Proof polling attempt ${job.attemptCount} for ${tokenId.slice(0, 8)}...: ${error}`);
      }
    }

    // Remove completed jobs
    for (const tokenId of completedJobs) {
      this.proofPollingJobs.delete(tokenId);
    }

    // Stop polling if no more jobs
    if (this.proofPollingJobs.size === 0) {
      this.stopProofPolling();
    }

    // Persist updated queue (attempt counts changed; some jobs removed).
    // Fire-and-forget — in-memory state is authoritative for this process.
    this.saveProofPollingJobs().catch((err: unknown) =>
      logger.debug('Payments', '[V6-PERSIST] saveProofPollingJobs after tick failed:', err)
    );
}
