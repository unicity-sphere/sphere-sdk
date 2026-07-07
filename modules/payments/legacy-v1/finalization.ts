/**
 * @internal Phase 5 [C] quarantine — Phase 6.C deletes this file wholesale.
 * The finalize* / V5-family finalization pipeline for v1-STSDK receivers.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Token } from '../../../types';
import type {
  PendingV5Finalization,
  UnconfirmedResolutionResult,
  InstantSplitBundleV5,
} from '../../../types/instant-split';
import { logger } from '../../../core/logger';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';
import { TokenRegistry } from '../../../registry';
import { SphereError } from '../../../core/errors';
import { sanitizeReasonString } from '../../../core/error-sanitize';
import { CidRefStore } from '../../../extensions/uxf/profile/cid-ref-store';
import { hexToBytes as fromHex } from '../../../core/hex';
import {
  parseSdkDataCached,
  clearSdkDataCache,
  extractTokenIdFromSdkData,
  extractStateHashFromSdkData,
  createTokenStateKey,
  extractTokenStateKey,
  pendingMintDedupKey,
  effectiveDedupKey,
  hasSameGenesisTokenId,
  isSameTokenState,
  countCommittedTxns,
} from '../tokens';
import {
  readV5FinalizationInputsFromToken,
  type V5FinalizationInputs,
  type ITransferCommitmentJson,
} from '../v5-pending-shape';
import {
  extractPendingChainFromSdkData,
  finalizeSourceTokenChain,
} from '../../../extensions/uxf/pipeline/conservative-source-finalize';
import { PredicateEngineService } from '@unicitylabs/state-transition-sdk/lib/predicate/PredicateEngineService';
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { CoinId } from '@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId';
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import { TransferTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import { AddressScheme } from '@unicitylabs/state-transition-sdk/lib/address/AddressScheme';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';
import { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof';
import { InvalidJsonStructureError } from '@unicitylabs/state-transition-sdk/lib/InvalidJsonStructureError';
import { VerificationError } from '@unicitylabs/state-transition-sdk/lib/verification/VerificationError';
import { TransferTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransactionData';
import { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId';
import { Authenticator } from '@unicitylabs/state-transition-sdk/lib/api/Authenticator';
import { MintTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData';
import { MintCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment';
import type { IAddress } from '@unicitylabs/state-transition-sdk/lib/address/IAddress';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase';

// ==============================================================================
// drainPendingFinalizations
// ==============================================================================

export async function drainPendingFinalizationsImpl(this: any, opts: {
    timeoutMs: number;
    pollIntervalMs: number;
    onProgress?: (result: UnconfirmedResolutionResult) => void;
  }): Promise<{
    finalization?: UnconfirmedResolutionResult;
    durationMs: number;
    timedOut: boolean;
    skipped: boolean;
  }> {
    const startTime = Date.now();

    // Drain race fix — must also wait for any inbound transfer pipelines
    // that haven't yet reached `addToken` (their tokens are not in
    // `this.tokens` yet, so the status scan below would miss them).
    // See `inflightReceiveCount` doc for why.
    //
    // Issue #378 (#275 P4) — a token whose tokenId is in the persistent
    // `v6RecoverPermanent` ledger is intentionally EXCLUDED from the
    // drain predicate even if its status reverted to 'submitted' /
    // 'pending'. The V6-RECOVER verdict is final ("HD-index recovery
    // exhausted" / "structural failure" — no retry semantically
    // recovers it); polling it on every `sphere balance` is wasted
    // wall-clock that historically stacked to ~60s per command.
    // Issue #387 — canonical-id-first lookup. The ledger is keyed by
    // canonical genesis tokenId; the map iteration key matches that
    // immediately after `loadFromStorageData` but can be a randomUUID
    // immediately after `addToken`. Use the helper so both forms
    // resolve correctly.
    const hasUnconfirmedOrInflight = (): boolean =>
      this.inflightReceiveCount > 0 ||
      Array.from(this.tokens.entries() as any).some(
        ([tokenId, t]: any) =>
          (t.status === 'submitted' || t.status === 'pending') &&
          !this.isV6RecoverPermanentToken(t, tokenId),
      );

    // Drain ingest worker pool first (UXF v1 path, defense in depth).
    // The pool's queue may hold accepted-but-not-yet-processed bundles;
    // waiting here serializes the drain against in-flight worker
    // processing so the post-drain wallet snapshot includes their
    // resulting tokens. Best-effort: any failure (timeout, pool not
    // installed) falls through to the legacy in-flight wait below.
    if (this.ingestPool) {
      try {
        await this.ingestPool.drainQueue(opts.timeoutMs);
      } catch (err) {
        logger.debug(
          'Payments',
          '[DRAIN] ingestPool.drainQueue threw or timed out (continuing):',
          err instanceof Error ? err.message : err,
        );
      }
    }

    // Fast path: nothing to drain.
    if (!hasUnconfirmedOrInflight()) {
      return { durationMs: 0, timedOut: false, skipped: true };
    }

    // No-oracle short-circuit: without stClient + trustBase,
    // resolveUnconfirmed() early-exits every iteration and the polling
    // loop would block for the full timeoutMs with zero progress.
    const stClient = this.deps!.oracle.getStateTransitionClient?.();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trustBase = (this.deps!.oracle as any).getTrustBase?.();
    if (!stClient || !trustBase) {
      logger.debug(
        'Payments',
        '[V5-RESOLVE] drainPendingFinalizations: oracle not wired (no stClient/trustBase) — skipping drain',
      );
      return { durationMs: 0, timedOut: hasUnconfirmedOrInflight(), skipped: true };
    }

    let finalization: UnconfirmedResolutionResult | undefined;

    while (Date.now() - startTime < opts.timeoutMs) {
      const resolution = await this.resolveUnconfirmed();
      finalization = resolution;
      if (opts.onProgress) opts.onProgress(resolution);

      if (!hasUnconfirmedOrInflight()) break;

      await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
      await this.load();
    }

    return {
      finalization,
      durationMs: Date.now() - startTime,
      timedOut: hasUnconfirmedOrInflight(),
      skipped: false,
    };
}

// ==============================================================================
// resolveUnconfirmed
// ==============================================================================

export async function resolveUnconfirmedImpl(this: any): Promise<UnconfirmedResolutionResult> {
    this.ensureInitialized();
    const result: UnconfirmedResolutionResult = {
      resolved: 0,
      stillPending: 0,
      failed: 0,
      details: [],
    };

    const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const trustBase = (this.deps!.oracle as any).getTrustBase?.() as RootTrustBase | undefined;
    if (!stClient || !trustBase) {
      logger.debug('Payments', `[V5-RESOLVE] resolveUnconfirmed: EARLY EXIT — stClient=${!!stClient} trustBase=${!!trustBase}`);
      return result;
    }

    const signingService = await this.createSigningService();

    const submittedCount = Array.from(this.tokens.values() as any).filter(
      (t: any) => t.status === 'submitted' || t.status === 'pending'
    ).length;
    logger.debug('Payments', `[V5-RESOLVE] resolveUnconfirmed: ${submittedCount} submitted/pending token(s) to process`);

    for (const [tokenId, token] of this.tokens) {
      // #144 L2: accept both 'submitted' (in-process V5/V6-direct) and
      // 'pending' (V6-direct after save→load round-trip — txfToToken flips
      // the status when the latest tx has `inclusionProof: null`).
      if (token.status !== 'submitted' && token.status !== 'pending') continue;

      // Check for pending finalization metadata (V5 split bundles).
      const pending = this.parsePendingFinalization(token.sdkData);

      if (pending?.type === 'v5_bundle') {
        logger.debug('Payments', `[V5-RESOLVE] Processing ${tokenId.slice(0, 16)}... stage=${pending.stage} attempt=${pending.attemptCount}`);
        const progress = await this.resolveV5Token(tokenId, token, pending, stClient, trustBase, signingService);
        logger.debug('Payments', `[V5-RESOLVE] Result for ${tokenId.slice(0, 16)}...: ${progress} (stage now: ${pending.stage})`);
        result.details.push({ tokenId, stage: pending.stage, status: progress });
        if (progress === 'resolved') result.resolved++;
        else if (progress === 'failed') result.failed++;
        else result.stillPending++;
        continue;
      }

      // #144 L2: V6-direct legacy entries (no `_pendingFinalization`).
      // If a persisted proof-polling job is tracking this token, attempt
      // finalization in our own cadence (defense-in-depth alongside the
      // ~2s background queue). If no job is registered, the token is
      // stranded — `recoverStrandedReceivedTokens` (L3 migration) handles
      // it on first load() after upgrade.
      if (this.isReceivedLegacyPending(token)) {
        const progress = await this.resolveLegacyReceivedToken(tokenId, token);
        const detailStatus: 'resolved' | 'pending' | 'failed' =
          progress === 'resolved' ? 'resolved'
          : progress === 'failed' ? 'failed'
          : 'pending';
        result.details.push({ tokenId, stage: 'v6_direct', status: detailStatus });
        if (progress === 'resolved') result.resolved++;
        else if (progress === 'failed') result.failed++;
        else result.stillPending++;
        continue;
      }

      // Local-finalize fallback for tokens whose state.predicate doesn't
      // match our wallet AND whose last tx is a fully-proven transfer
      // targeting us. These come from two scenarios:
      //   1. Sender pre-finalized (e.g., faucet shipped `{sourceToken,
      //      transferTx}` with proof) but our receive path's finalize
      //      threw — saved as status='pending' by the path C / D fix.
      //   2. Profile recovery from a CAR published by another device
      //      that contained un-finalized pending tokens — we now have
      //      the proven transfer tx on disk but state.predicate is
      //      still the sender's. We must apply the transition locally
      //      to update state.predicate to ours.
      // The transition is offline (the proof is already there). We just
      // need to call `stClient.finalizeTransaction(sourceToken, ourState,
      // transferTx, nametagTokens)` to construct the post-transition
      // token. On success, persist the new sdkData with status='confirmed';
      // on failure, leave the token unchanged and report stillPending so
      // the next periodic retry can try again.
      const localFinalizeResult = await this.tryLocalFinalizeUnconfirmed(
        tokenId,
        token,
        stClient,
        trustBase,
      );
      if (localFinalizeResult === 'resolved') {
        result.details.push({ tokenId, stage: 'local_finalize', status: 'resolved' });
        result.resolved++;
        continue;
      } else if (localFinalizeResult === 'failed') {
        result.details.push({ tokenId, stage: 'local_finalize', status: 'failed' });
        result.failed++;
        continue;
      } else if (localFinalizeResult === 'skipped') {
        // Some other shape we don't know about — count as still-pending.
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 16)}: no pending finalization metadata, no recipient match — skipping`);
        result.stillPending++;
      } else {
        // 'stillPending' — local finalize didn't apply (no recipient
        // match or no proof yet), but the token is legitimately pending.
        result.details.push({ tokenId, stage: 'local_finalize', status: 'pending' });
        result.stillPending++;
      }
    }

    // Always save when any token was processed — this persists intermediate
    // stage progress (e.g. RECEIVED → MINT_SUBMITTED) and attemptCount so
    // that reloads don't restart finalization from scratch.
    if (result.resolved > 0 || result.failed > 0 || result.stillPending > 0) {
      logger.debug('Payments', `[V5-RESOLVE] Saving: resolved=${result.resolved} failed=${result.failed} stillPending=${result.stillPending}`);
      await this.save();
    }
    return result;
}

// ==============================================================================
// scheduleResolveUnconfirmed
// ==============================================================================

export function scheduleResolveUnconfirmedImpl(this: any): void {
    // Don't stack intervals
    if (this.resolveUnconfirmedTimer) return;

    // Only start if there are unconfirmed tokens to resolve.
    // #144: include 'pending' status too — V6-direct receives flip from
    // 'submitted' to 'pending' after save→load and would never re-engage
    // the periodic retry otherwise.
    //
    // Issue #389 finding #8 — symmetry with `hasUnconfirmedOrInflight`
    // (which already consults the ledger). Without the ledger check
    // here, a cold-start window where `loadFromStorageData` has run
    // but `restoreV6RecoverPermanent`'s ledger hydrate or
    // `applyV6RecoverPermanentInvalidStatus` patch has not yet
    // completed would see ledgered tokens as `'pending'` and arm the
    // periodic retry timer for them — burning a `resolveUnconfirmed`
    // cycle every interval until they're patched. The pre-#389
    // load() ordering fix makes this window narrow; the guard here
    // closes it entirely.
    const hasUnconfirmed = Array.from(this.tokens.entries() as any).some(
      ([id, t]: any) =>
        (t.status === 'submitted' || t.status === 'pending') &&
        !this.isV6RecoverPermanentToken(t, id),
    );
    if (!hasUnconfirmed) {
      logger.debug('Payments', '[V5-RESOLVE] scheduleResolveUnconfirmed: no submitted/pending tokens, not starting timer');
      return;
    }

    logger.debug('Payments', `[V5-RESOLVE] scheduleResolveUnconfirmed: starting periodic retry (every ${(this.constructor as any).RESOLVE_UNCONFIRMED_INTERVAL_MS}ms)`);
    this.resolveUnconfirmedTimer = setInterval(async () => {
      try {
        const result = await this.resolveUnconfirmed();
        if (result.stillPending === 0) {
          logger.debug('Payments', '[V5-RESOLVE] All tokens resolved, stopping periodic retry');
          this.stopResolveUnconfirmedPolling();
        }
      } catch (err) {
        logger.debug('Payments', '[V5-RESOLVE] Periodic retry error:', err);
      }
    }, (this.constructor as any).RESOLVE_UNCONFIRMED_INTERVAL_MS);
}

// ==============================================================================
// stopResolveUnconfirmedPolling
// ==============================================================================

export function stopResolveUnconfirmedPollingImpl(this: any): void {
    if (this.resolveUnconfirmedTimer) {
      clearInterval(this.resolveUnconfirmedTimer);
      this.resolveUnconfirmedTimer = null;
    }
}

// ==============================================================================
// resolveV5Token
// ==============================================================================

export async function resolveV5TokenImpl(this: any, 
    tokenId: string,
    token: Token,
    pending: PendingV5Finalization,
    stClient: StateTransitionClient,
    trustBase: RootTrustBase,
    signingService: SigningService
  ): Promise<'resolved' | 'pending' | 'failed'> {
    pending.attemptCount++;
    pending.lastAttemptAt = Date.now();

    // Prefer shape-derived inputs; fall back to bundleJson for legacy
    // entries (pre-#207 opaque shape, or any case where the synthetic
    // shape is malformed). `inputs` is `let` (not const) so the
    // SDK-throws-on-shape-derived-input fallback can downgrade to
    // bundleJson within the same resolve attempt without burning a
    // full attemptCount cycle.
    let inputs = readV5FinalizationInputsFromToken(token.sdkData);
    let cachedBundle: InstantSplitBundleV5 | null = null;
    const getBundle = (): InstantSplitBundleV5 => {
      if (cachedBundle === null) {
        cachedBundle = JSON.parse(pending.bundleJson) as InstantSplitBundleV5;
      }
      return cachedBundle;
    };

    // Helper: produce a canonical `ITransferCommitmentJson` for
    // `TransferCommitment.fromJSON`. The shape-path derives `requestId`
    // from the authenticator's `publicKey` + `stateHash`
    // (deterministic — same as `RequestId.create(publicKey, stateHash)`
    // at commitment-construction time).
    //
    // #207 PR-B steelman — if Authenticator.fromJSON or RequestId.create
    // throw (shape passed our pre-validation but the SDK still rejects),
    // we MUST NOT burn an attemptCount for the structural failure.
    // Downgrade to the legacy bundleJson path inside the same attempt.
    const getTransferCommitmentJson = async (): Promise<ITransferCommitmentJson> => {
      if (inputs) {
        try {
          const auth = Authenticator.fromJSON(inputs.transferAuthenticatorJson);
          const requestId = await RequestId.create(auth.publicKey, auth.stateHash);
          return {
            requestId: requestId.toJSON(),
            transactionData: inputs.transferTransactionDataJson,
            authenticator: inputs.transferAuthenticatorJson,
          };
        } catch (err) {
          logger.warn(
            'Payments',
            `[V5-RESOLVE] ${tokenId.slice(0, 12)}: shape-derived transferCommitment construction failed (${(err as Error)?.message ?? err}); downgrading to bundleJson fallback`,
          );
          inputs = null;
        }
      }
      return JSON.parse(getBundle().transferCommitment) as ITransferCommitmentJson;
    };

    try {
      // Stage: RECEIVED → MINT_SUBMITTED
      if (pending.stage === 'RECEIVED') {
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: RECEIVED → submitting mint commitment...`);
        const mintDataJson = inputs?.mintDataJson ?? JSON.parse(getBundle().recipientMintData);
        const mintData = await MintTransactionData.fromJSON(mintDataJson);
        const mintCommitment = await MintCommitment.create(mintData);
        const mintResponse = await stClient.submitMintCommitment(mintCommitment);
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: mint response status=${mintResponse.status}`);
        if (mintResponse.status !== 'SUCCESS' && mintResponse.status !== 'REQUEST_ID_EXISTS') {
          throw new SphereError(`Mint submission failed: ${mintResponse.status}`, 'TRANSFER_FAILED');
        }
        pending.stage = 'MINT_SUBMITTED';
        this.updatePendingFinalization(token, pending);
      }

      // Stage: MINT_SUBMITTED → MINT_PROVEN
      if (pending.stage === 'MINT_SUBMITTED') {
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: MINT_SUBMITTED → checking mint proof...`);
        const mintDataJson = inputs?.mintDataJson ?? JSON.parse(getBundle().recipientMintData);
        const mintData = await MintTransactionData.fromJSON(mintDataJson);
        const mintCommitment = await MintCommitment.create(mintData);
        const proof = await this.quickProofCheck(stClient, trustBase, mintCommitment);
        if (!proof) {
          logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: mint proof not yet available, staying MINT_SUBMITTED`);
          this.updatePendingFinalization(token, pending);
          return 'pending';
        }
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: mint proof obtained!`);
        pending.mintProofJson = JSON.stringify(proof);
        pending.stage = 'MINT_PROVEN';
        this.updatePendingFinalization(token, pending);
      }

      // Stage: MINT_PROVEN → TRANSFER_SUBMITTED
      if (pending.stage === 'MINT_PROVEN') {
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: MINT_PROVEN → submitting transfer commitment...`);
        const transferCommitmentJson = await getTransferCommitmentJson();
        const transferCommitment = await TransferCommitment.fromJSON(transferCommitmentJson);
        const transferResponse = await stClient.submitTransferCommitment(transferCommitment);
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: transfer response status=${transferResponse.status}`);
        if (transferResponse.status !== 'SUCCESS' && transferResponse.status !== 'REQUEST_ID_EXISTS') {
          throw new SphereError(`Transfer submission failed: ${transferResponse.status}`, 'TRANSFER_FAILED');
        }
        pending.stage = 'TRANSFER_SUBMITTED';
        this.updatePendingFinalization(token, pending);
      }

      // Stage: TRANSFER_SUBMITTED → FINALIZED
      if (pending.stage === 'TRANSFER_SUBMITTED') {
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: TRANSFER_SUBMITTED → checking transfer proof...`);
        const transferCommitmentJson = await getTransferCommitmentJson();
        const transferCommitment = await TransferCommitment.fromJSON(transferCommitmentJson);
        const proof = await this.quickProofCheck(stClient, trustBase, transferCommitment);
        if (!proof) {
          logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: transfer proof not yet available, staying TRANSFER_SUBMITTED`);
          this.updatePendingFinalization(token, pending);
          return 'pending';
        }
        logger.debug('Payments', `[V5-RESOLVE] ${tokenId.slice(0, 12)}: transfer proof obtained! Finalizing...`);

        // Finalize: reconstruct minted token, create recipient state, finalize
        const finalizedToken = await this.finalizeFromV5Inputs(
          inputs,
          getBundle,
          pending,
          signingService,
          stClient,
          trustBase,
        );

        // Replace token with confirmed version containing real SDK data
        const confirmedToken: Token = {
          id: token.id,
          coinId: token.coinId,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          iconUrl: token.iconUrl,
          amount: token.amount,
          status: 'confirmed',
          createdAt: token.createdAt,
          updatedAt: Date.now(),
          sdkData: JSON.stringify(finalizedToken.toJSON()),
        };
        this.tokens.set(tokenId, confirmedToken);

        // #207 PR-B — Archive GC. If the CAR-loaded archived copy at
        // archivedTokens[actualTokenId] is still present (cross-device
        // sync produced a separate token entry under the real on-chain
        // tokenId, distinct from this resolution token's `v5split_*`
        // id), drop it: the active in-memory token is now the
        // confirmed authority.
        this.gcArchivedV5PendingForFinalized(finalizedToken);

        // Spend Queue: cache newly confirmed token and wake queued entries
        const resolvedAmount = this.extractCoinAmountForCache(finalizedToken, confirmedToken.coinId);
        if (resolvedAmount > 0n) {
          this.parsedTokenCache.set(tokenId, { token: confirmedToken, sdkToken: finalizedToken, amount: resolvedAmount });
          this.spendQueue.notifyChange(confirmedToken.coinId);
        }

        // History entry was already created in processInstantSplitBundle() — no duplicate here

        // Emit transfer:confirmed so the UI learns about the state change
        this.deps!.emitEvent('transfer:confirmed', {
          id: crypto.randomUUID(),
          status: 'completed',
          tokens: [confirmedToken],
          tokenTransfers: [],
        });

        logger.debug('Payments', `V5 token resolved: ${tokenId.slice(0, 8)}...`);
        return 'resolved';
      }

      return 'pending';
    } catch (error) {
      logger.error('Payments', `resolveV5Token failed for ${tokenId.slice(0, 8)}:`, error);
      if (pending.attemptCount > 50) {
        token.status = 'invalid';
        token.updatedAt = Date.now();
        this.tokens.set(tokenId, token);
        return 'failed';
      }
      this.updatePendingFinalization(token, pending);
      return 'pending';
    }
}

// ==============================================================================
// quickProofCheck
// ==============================================================================

export async function quickProofCheckImpl(this: any, 
    stClient: StateTransitionClient,
    trustBase: RootTrustBase,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    commitment: any,
    timeoutMs: number = 500
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any | null> {
    try {
      const proof = await Promise.race([
        waitInclusionProof(trustBase, stClient, commitment),
        new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      return proof;
    } catch {
      return null;
    }
}

// ==============================================================================
// finalizeFromV5Inputs
// ==============================================================================

export async function finalizeFromV5InputsImpl(this: any, 
    inputs: V5FinalizationInputs | null,
    getBundle: () => InstantSplitBundleV5,
    pending: PendingV5Finalization,
    signingService: SigningService,
    stClient: StateTransitionClient,
    trustBase: RootTrustBase
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<SdkToken<any>> {
    // Reconstruct minted token from bundle data
    const mintDataJson = inputs?.mintDataJson ?? JSON.parse(getBundle().recipientMintData);
    const mintData = await MintTransactionData.fromJSON(mintDataJson);
    const mintCommitment = await MintCommitment.create(mintData);
    const mintProofJson = JSON.parse(pending.mintProofJson!);
    const mintProof = InclusionProof.fromJSON(mintProofJson);
    const mintTransaction = mintCommitment.toTransaction(mintProof);

    const tokenTypeHex = inputs?.tokenTypeHex ?? getBundle().tokenTypeHex;
    const tokenType = new TokenType(fromHex(tokenTypeHex));
    const senderMintedStateJson = inputs?.mintedTokenStateJson
      ?? JSON.parse(getBundle().mintedTokenStateJson);

    const tokenJson = {
      version: '2.0',
      state: senderMintedStateJson,
      genesis: mintTransaction.toJSON(),
      transactions: [],
      nametags: [],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mintedToken = await SdkToken.fromJSON(tokenJson) as SdkToken<any>;

    // Create transfer transaction. Same lazy-shape-vs-bundle preference
    // as in resolveV5Token: derive requestId from the authenticator if
    // we have shape inputs. SDK-throw → fall back to bundleJson rather
    // than failing the whole finalize.
    let transferCommitment: TransferCommitment;
    if (inputs) {
      try {
        const auth = Authenticator.fromJSON(inputs.transferAuthenticatorJson);
        const requestId = await RequestId.create(auth.publicKey, auth.stateHash);
        transferCommitment = await TransferCommitment.fromJSON({
          requestId: requestId.toJSON(),
          transactionData: inputs.transferTransactionDataJson,
          authenticator: inputs.transferAuthenticatorJson,
        });
      } catch (err) {
        logger.warn(
          'Payments',
          `[V5-RESOLVE] finalize: shape-derived transferCommitment failed (${(err as Error)?.message ?? err}); using bundleJson fallback`,
        );
        transferCommitment = await TransferCommitment.fromJSON(
          JSON.parse(getBundle().transferCommitment),
        );
      }
    } else {
      transferCommitment = await TransferCommitment.fromJSON(
        JSON.parse(getBundle().transferCommitment),
      );
    }
    const transferProof = await waitInclusionProof(trustBase, stClient, transferCommitment);
    const transferTransaction = transferCommitment.toTransaction(transferProof);

    // Create recipient state
    const transferSaltHex = inputs?.transferSaltHex ?? getBundle().transferSaltHex;
    const transferSalt = fromHex(transferSaltHex);
    const recipientPredicate = await UnmaskedPredicate.create(
      mintData.tokenId,
      tokenType,
      signingService,
      HashAlgorithm.SHA256,
      transferSalt
    );
    const recipientState = new TokenState(recipientPredicate, null);

    // Handle nametag tokens for PROXY addresses
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let nametagTokens: SdkToken<any>[] = [];
    const recipientAddressStr = inputs?.recipientAddress ?? getBundle().recipientAddressJson;

    if (recipientAddressStr.startsWith('PROXY://')) {
      // Try to get nametag token from bundle first. (#207 PR-B follow-up:
      // the nametag token isn't yet carried in the synthetic token shape
      // because UXF doesn't preserve nested wallet-internal Token JSON.
      // For PROXY recipients we still need the bundleJson — graceful
      // fallback below to a local nametag covers most real-world cases.)
      let nametagTokenJson: string | undefined;
      try {
        nametagTokenJson = getBundle().nametagTokenJson;
      } catch {
        nametagTokenJson = undefined;
      }
      if (nametagTokenJson) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nametagToken = await SdkToken.fromJSON(JSON.parse(nametagTokenJson)) as SdkToken<any>;
          const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
          const proxy = await ProxyAddress.fromTokenId(nametagToken.id);
          if (proxy.address === recipientAddressStr) {
            nametagTokens = [nametagToken];
          }
        } catch {
          // Fall through to local nametag lookup
        }
      }

      // If not in bundle, try local nametag
      const localNametag = this.getNametag();
      if (nametagTokens.length === 0 && localNametag?.token) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const nametagToken = await SdkToken.fromJSON(localNametag.token) as SdkToken<any>;
          const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
          const proxy = await ProxyAddress.fromTokenId(nametagToken.id);
          if (proxy.address === recipientAddressStr) {
            nametagTokens = [nametagToken];
          }
        } catch {
          // No nametag available
        }
      }
    }

    // Finalize
    return stClient.finalizeTransaction(trustBase, mintedToken, recipientState, transferTransaction, nametagTokens);
}

// ==============================================================================
// isReceivedLegacyPending
// ==============================================================================

export function isReceivedLegacyPendingImpl(this: any, token: Token): boolean {
    if (!token.sdkData) return false;
    let parsed: { transactions?: unknown };
    try {
      parsed = JSON.parse(token.sdkData);
    } catch {
      return false;
    }
    if (!parsed || typeof parsed !== 'object') return false;
    const txs = (parsed as { transactions?: unknown[] }).transactions;
    if (!Array.isArray(txs) || txs.length === 0) return false;
    const lastTx = txs[txs.length - 1] as {
      inclusionProof?: unknown;
      data?: { recipient?: string | { address?: string } };
    };
    // Canonical default: missing inclusionProof === null (the V5/V6 protocol
    // treats both `inclusionProof: null` and the absence of the field as
    // "transaction is pending"). Without this default, a producer that
    // omits the field would see `lastTx.inclusionProof === undefined`,
    // fail this `!== null` check, and incorrectly be classified as
    // not-pending — leaving the token stranded by the balance-model
    // invariant in `loadFromStorageData`.
    const proof = lastTx.inclusionProof === undefined ? null : lastTx.inclusionProof;
    if (proof !== null) return false;
    const recipientField = lastTx.data?.recipient;
    const recipientAddr =
      typeof recipientField === 'string'
        ? recipientField
        : (recipientField && typeof recipientField === 'object'
            ? recipientField.address
            : undefined);
    if (typeof recipientAddr !== 'string') return false;

    // DIRECT match — `identity.directAddress` is normalized to
    // `DIRECT://...`; tx recipient should match exactly.
    const directAddr = this.deps!.identity.directAddress;
    if (directAddr && recipientAddr === directAddr) return true;

    // PROXY exact match — steelman FIX F (#144). Requires the
    // `proxyAddressCache` to have been primed via
    // `primeProxyAddressCache` (called from `load()`). Tokens addressed
    // to a PROXY we don't hold are rejected, preventing recover-load
    // amplification by malicious peers crafting PROXY://<garbage> TXFs.
    if (recipientAddr.startsWith('PROXY://')) {
      return this.proxyAddressCache.has(recipientAddr);
    }

    return false;
}

// ==============================================================================
// primeProxyAddressCache
// ==============================================================================

export async function primeProxyAddressCacheImpl(this: any): Promise<void> {
    this.proxyAddressCache.clear();
    for (const nametagRecord of this.nametags) {
      const tokenJson = nametagRecord?.token as unknown;
      if (!tokenJson) continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nametagToken = await SdkToken.fromJSON(tokenJson as any) as SdkToken<any>;
        const { ProxyAddress } = await import(
          '@unicitylabs/state-transition-sdk/lib/address/ProxyAddress'
        );
        const proxy = await ProxyAddress.fromTokenId(nametagToken.id);
        this.proxyAddressCache.add(proxy.address);
      } catch (err) {
        logger.debug(
          'Payments',
          `[PROXY-CACHE] Failed to derive PROXY for nametag ${nametagRecord?.name ?? '?'}:`,
          err,
        );
      }
    }
}

// ==============================================================================
// hasFinalizationPlan
// ==============================================================================

export function hasFinalizationPlanImpl(this: any, token: Token): boolean {
    if (this.parsePendingFinalization(token.sdkData)) return true;
    if (this.proofPollingJobs.has(token.id)) return true;
    if (this.isReceivedLegacyPending(token)) return true;
    return false;
}

// ==============================================================================
// latestStatePredicateMatchesWallet
// ==============================================================================

export function latestStatePredicateMatchesWalletImpl(this: any, token: Token): boolean {
    if (!token.sdkData) return true;
    let parsed: { state?: { predicate?: string | { publicKey?: string } } };
    try {
      parsed = JSON.parse(token.sdkData);
    } catch {
      return true;
    }
    const predicate = parsed?.state?.predicate;
    if (!predicate) return true;

    // Use the cached signing-service pubkey when available. Fallback to
    // identity.chainPubkey when the signing pubkey hasn't been resolved
    // yet (only happens at first load, before any send/receive has run
    // — in that window we err on the side of "keep visible").
    const signingPubkey = this._signingPublicKeyHex;
    const chainPubkey = this.deps!.identity.chainPubkey?.toLowerCase();
    const candidates = [signingPubkey, chainPubkey].filter(
      (k): k is string => typeof k === 'string' && k.length > 0,
    );
    if (candidates.length === 0) return true;

    if (typeof predicate === 'string') {
      const predLower = predicate.toLowerCase();
      return candidates.some((k) => predLower.includes(k));
    }
    if (typeof predicate === 'object' && typeof predicate.publicKey === 'string') {
      const pkLower = predicate.publicKey.toLowerCase();
      return candidates.some((k) => pkLower === k);
    }
    return true;
}

// ==============================================================================
// recoverStrandedReceivedTokens
// ==============================================================================

export async function recoverStrandedReceivedTokensImpl(this: any): Promise<number> {
    let recovered = 0;
    for (const [tokenId, token] of this.tokens) {
      if (token.status !== 'pending') continue;
      if (this.proofPollingJobs.has(tokenId)) continue;
      // Issue #378 (#275 P4) — a tokenId already in the persistent
      // permanent-verdict ledger has been classified as un-recoverable
      // (HD-index recovery exhausted or structural failure). Re-running
      // the recovery scan against it on every cold start would pay
      // multi-second probe + finalize costs per stranded token without
      // ever changing the verdict. Skip until an operator explicitly
      // forces a retry via `payments receive --finalize` (which clears
      // the ledger).
      //
      // Issue #387 — use canonical-id-first lookup. The ledger is keyed
      // by canonical genesis tokenId; the map iteration key matches
      // that immediately after `loadFromStorageData` but `addToken` from
      // a Nostr replay can re-key under a `crypto.randomUUID`. The
      // `isV6RecoverPermanentToken` helper handles both forms.
      if (this.isV6RecoverPermanentToken(token, tokenId)) continue;
      if (this.parsePendingFinalization(token.sdkData)) continue;
      if (!this.isReceivedLegacyPending(token)) continue;

      // Parse sdkData to reach the last tx + source state.
      if (!token.sdkData) continue;
      let parsed: {
        transactions?: Array<{ data?: unknown; inclusionProof?: unknown }>;
      };
      try {
        parsed = JSON.parse(token.sdkData);
      } catch (err) {
        logger.debug(
          'Payments',
          `[V6-RECOVER] ${tokenId.slice(0, 12)}: sdkData parse failed: ${(err as Error).message}`,
        );
        continue;
      }
      const txs = parsed.transactions;
      if (!Array.isArray(txs) || txs.length === 0) continue;
      const lastTxJson = txs[txs.length - 1];
      if (!lastTxJson || lastTxJson.data == null) continue;

      try {
        // Derive requestIdHex from source state's predicate publicKey +
        // sourceStateHash (mirrors the recipient UXF worker recipe at
        // line ~1876 — same canonical derivation aggregator uses).
        const txData = await TransferTransactionData.fromJSON(lastTxJson.data);
        const senderPredicate = await PredicateEngineService.createPredicate(
          txData.sourceState.predicate,
        );
        const senderPubkey = (senderPredicate as unknown as { publicKey?: Uint8Array }).publicKey;
        if (!(senderPubkey instanceof Uint8Array) || senderPubkey.length === 0) {
          logger.debug(
            'Payments',
            `[V6-RECOVER] ${tokenId.slice(0, 12)}: sender predicate has no publicKey, skipping`,
          );
          continue;
        }
        const sourceStateHash = await txData.sourceState.calculateHash();
        const requestId = await RequestId.create(senderPubkey, sourceStateHash);
        const requestIdHex = requestId.toJSON();

        // Build the source-at-state-N-1 by stripping the last tx. This is
        // the same shape `assembleAtState(tokenId, txCount - 1)` produces
        // for the UXF path. `SdkToken.fromJSON` only accepts source tokens
        // whose transactions all have inclusionProofs.
        //
        // Issue #390 — also reset `state` to the transfer's `sourceState`
        // (the sender's mint state). The top-level `parsed.state` was
        // written by the ingestion path with the RECIPIENT's predicate so
        // the on-disk shape advertises bob as the owner once finalize
        // completes. But the SOURCE token (state N-1) used by
        // `Token.update` → `transaction.verify` → `verifyRecipient` must
        // expose the SENDER's predicate so the
        // `expectedRecipient == previousTransaction.recipient`
        // invariant holds (alice's mint state predicate ⇒ alice's
        // directAddress, which equals genesis.data.recipient). Without
        // this fix, every fresh-send V6-RECOVER path failed permanently
        // with "Recipient address mismatch" and the receiver lost the
        // value (#387/#388/#389 only stamped the durable verdict —
        // they did NOT fix this construction). Mirrors the correct
        // pattern in `tryLocalFinalizeUnconfirmed` (~line 10249).
        const sourceTokenJsonObj = {
          ...parsed,
          state: (lastTxJson.data as { sourceState?: unknown }).sourceState,
          transactions: txs.slice(0, -1),
        };
        const sourceTokenJson = JSON.stringify(sourceTokenJsonObj);

        // Option B (token-local recovery): if the synthetic pending tx
        // carries a `_wallet.authenticator`, we can reconstruct a full
        // `TransferCommitment` and re-submit it to the aggregator. The
        // authenticator is the SENDER's signature — the aggregator
        // verifies it without caring who submits. This closes the
        // recovery gap where a sender's CLI exits before its
        // fire-and-forget background submit completes: the recipient,
        // after a profile wipe + re-import-from-mnemonic, can push the
        // commitment on the sender's behalf.
        //
        // If the embedded authenticator is missing or fails to parse,
        // fall back to the legacy `commitmentJson: ''` path — the
        // polling queue's `getProof(requestIdHex)` fallback still works
        // when the sender DID submit the commitment.
        let recoveredCommitmentJson = '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const walletField = (lastTxJson as any)._wallet;
        if (
          walletField &&
          typeof walletField === 'object' &&
          walletField !== null &&
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (walletField as any).authenticator
        ) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const authJson = (walletField as any).authenticator;
            const commitmentObj = {
              requestId: requestIdHex,
              transactionData: lastTxJson.data,
              authenticator: authJson,
            };
            // Validate via fromJSON to catch malformed authenticators
            // now rather than at submit time.
            await TransferCommitment.fromJSON(commitmentObj);
            recoveredCommitmentJson = JSON.stringify(commitmentObj);
            logger.debug(
              'Payments',
              `[V6-RECOVER] ${tokenId.slice(0, 12)}: extracted embedded authenticator — full commitment recovery enabled`,
            );
          } catch (cmtErr) {
            logger.debug(
              'Payments',
              `[V6-RECOVER] ${tokenId.slice(0, 12)}: embedded authenticator invalid (${(cmtErr as Error)?.message ?? cmtErr}); falling back to getProof-only path`,
            );
          }
        }

        // Register a proof-polling job. When `commitmentJson` is set,
        // the polling queue's `waitForProofSdk(commitment)` path is
        // used; when empty, it falls back to `getProof(requestIdHex)`
        // (#144 L3 path).
        const lastTxJsonSnapshot = JSON.parse(JSON.stringify(lastTxJson));
        this.proofPollingJobs.set(tokenId, {
          tokenId,
          requestIdHex,
          commitmentJson: recoveredCommitmentJson,
          sourceTokenJson,
          startedAt: Date.now(),
          attemptCount: 0,
          lastAttemptAt: 0,
          onProofReceived: async (tid: string) => {
            await this.finalizeStrandedReceivedToken(
              tid,
              sourceTokenJson,
              lastTxJsonSnapshot,
            );
          },
        });

        // If we have the full commitment, fire-and-forget submit so the
        // aggregator processes it even if the original sender never did.
        // The submit is idempotent on the aggregator side; the polling
        // queue picks up the proof on its next tick.
        if (recoveredCommitmentJson) {
          const commitmentJsonForSubmit = recoveredCommitmentJson;
          (async () => {
            try {
              const stClient = this.deps!.oracle.getStateTransitionClient?.() as
                | StateTransitionClient
                | undefined;
              if (!stClient) return;
              const commitment = await TransferCommitment.fromJSON(
                JSON.parse(commitmentJsonForSubmit),
              );
              const response = await stClient.submitTransferCommitment(commitment);
              logger.debug(
                'Payments',
                `[V6-RECOVER] ${tokenId.slice(0, 12)}: re-submitted sender's commitment, status=${(response as { status?: unknown })?.status ?? 'unknown'}`,
              );
            } catch (submitErr) {
              // Non-fatal — the polling queue's getProof fallback still
              // runs. The aggregator may already have the commitment
              // from the sender's original submit attempt.
              logger.debug(
                'Payments',
                `[V6-RECOVER] ${tokenId.slice(0, 12)}: commitment re-submit failed (${(submitErr as Error)?.message ?? submitErr}); polling queue will retry via getProof`,
              );
            }
          })();
        }

        recovered++;
        logger.debug(
          'Payments',
          `[V6-RECOVER] Registered recovery job for stranded token ${tokenId.slice(0, 12)} (requestId=${requestIdHex.slice(0, 16)}..., commitmentRecovered=${recoveredCommitmentJson !== ''})`,
        );
      } catch (err) {
        logger.debug(
          'Payments',
          `[V6-RECOVER] ${tokenId.slice(0, 12)}: requestIdHex derivation failed: ${(err as Error)?.message ?? err}`,
        );
      }
    }

    if (recovered > 0) {
      this.startProofPolling();
      this.saveProofPollingJobs().catch((err: unknown) =>
        logger.debug('Payments', '[V6-PERSIST] saveProofPollingJobs after recover failed:', err),
      );
    }
    return recovered;
}

// ==============================================================================
// finalizeStrandedReceivedToken
// ==============================================================================

export async function finalizeStrandedReceivedTokenImpl(this: any, 
    tokenId: string,
    sourceTokenJson: string,
    lastTxJson: Record<string, unknown>,
  ): Promise<void> {
    try {
      const job = this.proofPollingJobs.get(tokenId);
      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trustBase = (this.deps!.oracle as any).getTrustBase?.();
      if (!stClient || !trustBase || !job) {
        logger.debug('Payments', `[V6-RECOVER] Cannot finalize ${tokenId.slice(0, 12)} — missing client/trustBase/job`);
        return;
      }

      // Fetch the proof one more time (the queue already saw it, but it
      // doesn't pass the proof through to the callback).
      //
      // Issue #251 — `OracleProvider.getProof` returns the local wrapper
      // shape `{ requestId, roundNumber, proof, timestamp }` where the
      // SDK-shaped `IInclusionProofJson` (carrying `merkleTreePath`,
      // `authenticator`, `transactionHash`, `unicityCertificate`) lives
      // under `.proof`. `TransferTransaction.fromJSON` ultimately calls
      // `InclusionProof.isJSON` which requires `merkleTreePath` AND
      // `unicityCertificate` at the top level of the patched
      // `inclusionProof` value. Pre-fix this code passed the wrapper
      // through (the wrapper has no `toJSON()` method), and every
      // cross-device finalize tripped `InvalidJsonStructureError` —
      // surfacing as the §C.4 "Stranded receive hit permanent structural
      // failure" loop on peer2-alice.
      //
      // Order matters:
      //   1. Wrapper with `.proof` (canonical OracleProvider return).
      //   2. SDK `InclusionProof` instance carrying `.toJSON()` — kept
      //      for callers that mock/return an instance directly.
      //   3. Already-JSON shape — defensive pass-through.
      let proofJson: unknown = null;
      const proof = await this.deps!.oracle.getProof(job.requestIdHex);
      if (proof) {
        const wrapper = proof as { proof?: unknown; toJSON?: () => unknown };
        if (wrapper.proof !== undefined && wrapper.proof !== null) {
          proofJson = wrapper.proof;
        } else if (
          // Steelman finding (PR #252 review): the OracleProvider
          // interface declares `proof: unknown`, so a wrapper whose
          // inner proof is null/undefined is structurally valid even
          // though `UnicityAggregatorProvider` short-circuits this case
          // to `null` today. If we reached this branch via the wrapper
          // shape (i.e., the object carries the wrapper's signature
          // fields) treat it as "proof not yet available" rather than
          // falling through to pass the wrapper itself — which would
          // crash `TransferTransaction.fromJSON` exactly the way this
          // PR fixes for the non-null case.
          'proof' in wrapper && typeof (wrapper as { roundNumber?: unknown }).roundNumber === 'number'
        ) {
          proofJson = null;
        } else if (typeof wrapper.toJSON === 'function') {
          proofJson = wrapper.toJSON();
        } else {
          proofJson = proof;
        }
      }
      if (!proofJson) {
        logger.debug('Payments', `[V6-RECOVER] Proof for ${tokenId.slice(0, 12)} unavailable on re-fetch — leaving for next tick`);
        return;
      }

      // Patch the lastTxJson with the now-available inclusionProof and
      // reconstruct the SDK transfer transaction.
      const finalizedTxJson = { ...lastTxJson, inclusionProof: proofJson };
      const transferTx = await TransferTransaction.fromJSON(finalizedTxJson);

      // Source token at state N-1 (last tx stripped — see
      // `recoverStrandedReceivedTokens`).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sourceToken = await SdkToken.fromJSON(JSON.parse(sourceTokenJson)) as SdkToken<any>;

      const finalizedSdkToken = await this.finalizeTransferToken(
        sourceToken,
        transferTx,
        stClient,
        trustBase,
      );

      const token = this.tokens.get(tokenId);
      if (!token) {
        logger.debug('Payments', `[V6-RECOVER] Token ${tokenId.slice(0, 12)} disappeared before finalize completed`);
        return;
      }
      const finalizedToken: Token = {
        ...token,
        status: 'confirmed',
        updatedAt: Date.now(),
        sdkData: JSON.stringify(finalizedSdkToken.toJSON()),
      };
      this.tokens.set(tokenId, finalizedToken);
      await this.save();

      // Update spend-queue cache with newly-confirmed token.
      const amount = this.extractCoinAmountForCache(finalizedSdkToken, finalizedToken.coinId);
      if (amount > 0n) {
        this.parsedTokenCache.set(tokenId, { token: finalizedToken, sdkToken: finalizedSdkToken, amount });
        this.spendQueue.notifyChange(finalizedToken.coinId);
      }

      this.deps!.emitEvent('transfer:confirmed', {
        id: crypto.randomUUID(),
        status: 'completed',
        tokens: [finalizedToken],
        tokenTransfers: [],
      });

      logger.debug('Payments', `[V6-RECOVER] Finalized stranded receive ${tokenId.slice(0, 12)} → confirmed`);
    } catch (err) {
      // Classify the error: some failures cannot be fixed by retry. Without
      // classification, V6-RECOVER would re-register the job on every process
      // restart (via `recoverStrandedReceivedTokens`) and `drainPendingFinalizations`
      // would burn its full timeout window every sync, spamming the operator
      // and stalling §D.1 of the soak harness.
      //
      // Two permanent classes are recognised here:
      //
      //  (a) Structural / parse-shape failures — `InvalidJsonStructureError`
      //      from SDK `TransferTransaction.fromJSON` / `InclusionProof.fromJSON`.
      //      The on-disk `lastTxJson` or the aggregator `proofJson` is malformed;
      //      no amount of re-polling changes the bytes. Issue: sphere-sdk#231.
      //
      //  (b) Recipient address mismatch — SDK `VerificationError` with inner
      //      `verificationResult.message === 'Recipient address mismatch'` (from
      //      `Token.verifyRecipient`, surfaced via `transaction.verify` →
      //      `token.update`'s "Transaction verification failed" wrapper, OR
      //      directly via "Recipient verification failed" in `token.update`).
      //      By the time we reach this catch, `finalizeTransferToken` has
      //      already invoked `tryRecoverSigningServiceForRecipient` and exhausted
      //      every tracked HD address — none of our signers derive the predicate
      //      the sender targeted. Retrying with the same inputs cannot succeed.
      //      Issue: sphere-sdk#269. The reversibility hook (re-trying once a
      //      previously untracked HD index gets activated) is deferred; for now
      //      operators see the `not-our-state` alert and can re-scan after
      //      activating the missing index manually.
      //
      // Permanent failure handling (both classes):
      //   1. Mark the token as 'invalid' so `recoverStrandedReceivedTokens`
      //      doesn't re-pick it up on next load.
      //   2. Remove any live proof-polling job for this token.
      //   3. Emit `transfer:operator-alert` with the appropriate canonical
      //      disposition reason — `structural` for (a), `not-our-state` for (b).
      //   4. (Structural only) Log the shape of `lastTxJson` / `proofJson` at
      //      debug level so SDK developers can diagnose the underlying SDK
      //      mismatch. Only top-level keys are logged — full payloads may
      //      contain large authenticator bytes we don't need to dump.
      const isStructural = err instanceof InvalidJsonStructureError ||
        (err as { name?: string } | null)?.name === 'InvalidJsonStructureError';

      // (b) Recipient address mismatch. We accept either an `instanceof
      // VerificationError` OR a duck-typed shape (`verificationResult.status`
      // + recognisable message) so the classifier survives bundle-duplication
      // edge cases where the SDK module loaded by the catch site differs from
      // the one that constructed the thrown error (tsup multi-entry,
      // hoisted-vs-nested dep resolution, ESM/CJS interop in tests).
      const verificationResult = (err as { verificationResult?: { status?: number; message?: string } } | null)
        ?.verificationResult;
      const isMismatchMessage = (msg: string | undefined): boolean =>
        typeof msg === 'string' && (
          msg === 'Recipient address mismatch' ||
          msg.includes('address mismatch')
        );
      const isPermanentMismatch =
        (err instanceof VerificationError || (err as { name?: string } | null)?.name === 'VerificationError') &&
        verificationResult?.status === 1 &&
        isMismatchMessage(verificationResult.message);

      const isPermanent = isStructural || isPermanentMismatch;

      if (isPermanent) {
        const classLabel = isPermanentMismatch
          ? 'permanent recipient-address mismatch (HD-index recovery exhausted)'
          : 'permanent structural failure';
        logger.error(
          'Payments',
          `[V6-RECOVER] Stranded receive ${tokenId.slice(0, 12)} hit ${classLabel} (no retry):`,
          err,
        );

        // One-shot diagnostic dump so the SDK-level shape can be inspected.
        // Top-level keys only — full bodies can carry large fields (proofs,
        // authenticators) that aren't necessary for SDK-error triage.
        // Skipped for the not-our-state path — the bytes are well-formed; the
        // useful diagnostic was already emitted by `tryRecoverSigningServiceForRecipient`
        // as a `[FINALIZE-RECOVER]` warn line naming the divergent addresses.
        if (isStructural) {
        try {
          const job = this.proofPollingJobs.get(tokenId);
          let proofShape: string[] | string = 'not-fetched';
          if (job) {
            try {
              const proof = await this.deps!.oracle.getProof(job.requestIdHex);
              if (proof) {
                // Issue #251 — mirror the unwrap order used in the
                // finalize path (above) so the diagnostic logs the
                // canonical SDK keys, not the OracleProvider wrapper
                // keys. Misleading-but-noisy → useful triage signal.
                const wrapper = proof as { proof?: unknown; toJSON?: () => unknown };
                let pj: unknown;
                if (wrapper.proof !== undefined && wrapper.proof !== null) {
                  pj = wrapper.proof;
                } else if (
                  'proof' in wrapper && typeof (wrapper as { roundNumber?: unknown }).roundNumber === 'number'
                ) {
                  // Wrapper-shape but proof payload absent — diagnostic
                  // logs this as 'null' rather than dumping wrapper keys.
                  pj = null;
                } else if (typeof wrapper.toJSON === 'function') {
                  pj = wrapper.toJSON();
                } else {
                  pj = proof;
                }
                proofShape = pj === null
                  ? 'null'
                  : pj && typeof pj === 'object'
                    ? Object.keys(pj as Record<string, unknown>)
                    : `non-object:${typeof pj}`;
              } else {
                proofShape = 'null';
              }
            } catch (fetchErr) {
              proofShape = `fetch-threw:${(fetchErr as Error)?.message ?? fetchErr}`;
            }
          }
          const lastTxKeys = lastTxJson && typeof lastTxJson === 'object'
            ? Object.keys(lastTxJson)
            : `non-object:${typeof lastTxJson}`;
          logger.debug(
            'Payments',
            `[V6-RECOVER] ${tokenId.slice(0, 12)} diagnostic shapes: lastTxJsonKeys=${JSON.stringify(lastTxKeys)} proofKeys=${JSON.stringify(proofShape)}`,
          );
        } catch (diagErr) {
          logger.debug('Payments', `[V6-RECOVER] ${tokenId.slice(0, 12)} diagnostic dump itself threw:`, diagErr);
        }
        }

        // 1. Mark the token as invalid so subsequent load() runs skip it.
        const token = this.tokens.get(tokenId);
        if (token && (token.status === 'pending' || token.status === 'submitted')) {
          token.status = 'invalid';
          token.updatedAt = Date.now();
          this.tokens.set(tokenId, token);
          try {
            await this.save();
          } catch (saveErr) {
            logger.warn('Payments', `[V6-RECOVER] Failed to persist invalid status for ${tokenId.slice(0, 12)}:`, saveErr);
          }
        }

        // 1a. Issue #378 (#275 P4) — record the verdict in the
        // persistent ledger so subsequent `drainPendingFinalizations`
        // and `recoverStrandedReceivedTokens` scans short-circuit
        // this tokenId in <100ms instead of repeating the V6-RECOVER
        // probe + the 60s drain timeout. Defense-in-depth above the
        // status='invalid' write at step 1: a load() that re-ingests
        // the source TXF bytes from disk would re-derive the in-memory
        // token map and could (depending on the storage layer's
        // status-merge semantics) restore the original 'submitted'
        // status. The persistent ledger key is independent of the
        // token bytes and so survives those round-trips deterministically.
        //
        // Issue #387 — confirmed: `determineTokenStatus` only emits
        // {pending, confirmed} from TXF; the in-memory `'invalid'`
        // write at step 1 above is LOST on the next load. The ledger
        // is now the SOLE durable representation of the verdict, and
        // `loadFromStorageData` → `applyV6RecoverPermanentInvalidStatus`
        // re-derives the `'invalid'` status from the ledger after
        // every load + sync. Use the canonical genesis tokenId
        // (extracted from `sdkData`) as the ledger key so the value
        // is stable across `addToken` UUID re-keying — it always
        // equals the storage-derived map key post-load.
        const ledgerKey =
          (token && extractTokenIdFromSdkData(token.sdkData)) ?? tokenId;
        this.v6RecoverPermanent.set(ledgerKey, {
          reason: classLabel,
          ts: Date.now(),
        });
        // Await persistence so a process exit immediately after the
        // verdict (e.g. CLI completion) cannot lose the entry. The
        // ledger is now load-bearing for balance correctness — we can
        // no longer afford fire-and-forget here.
        //
        // Issue #389 finding #11 — if the persist fails (storage
        // unavailable, disk full, IndexedDB transaction rejected),
        // the verdict survives only in memory. On CLI exit the
        // verdict is lost; the next session re-runs the full
        // V6-RECOVER probe + 60s drain timeout cycle. Bump the log
        // level to `error` so observability surfaces it (operators
        // grep for `[V6-RECOVER-PERM]` ERROR lines), and schedule a
        // best-effort retry on a short backoff so a transient storage
        // hiccup self-heals before the next session's load(). The
        // in-memory `'invalid'` status from step 1 above still
        // protects the current session's balance.
        //
        // We deliberately do NOT emit `transfer:operator-alert` here
        // — that event surface is constrained to the §5.4
        // `DispositionReason` enum (14 values, snapshot-tested) which
        // is a transfer-disposition contract, not a generic operator
        // channel. A storage-side failure does not fit any of the
        // existing codes and adding a new one requires an ADR.
        try {
          await this.saveV6RecoverPermanent();
        } catch (persistErr) {
          logger.error(
            'Payments',
            `[V6-RECOVER-PERM] saveV6RecoverPermanent after permanent-fail mark failed (in-memory verdict ` +
              `for ${tokenId.slice(0, 12)} is correct, but will be lost on restart):`,
            persistErr,
          );
          this.scheduleV6RecoverPermanentSaveRetry();
        }

        // 2. Remove the proof-polling job and persist the change.
        this.proofPollingJobs.delete(tokenId);
        this.saveProofPollingJobs().catch((persistErr: unknown) =>
          logger.debug('Payments', `[V6-RECOVER] saveProofPollingJobs after permanent-fail mark failed:`, persistErr),
        );

        // 3. Surface to operator/UI via the canonical disposition reason.
        //    - structural  → parse-shape failure that no retry fixes
        //    - not-our-state → recipient predicate doesn't bind to any of
        //      our tracked HD signers; structurally valid, just unspendable
        //      by us with currently-tracked addresses.
        try {
          const innerMsg = verificationResult?.message;
          const alertCode = isPermanentMismatch ? 'not-our-state' : 'structural';
          const alertMessage = isPermanentMismatch
            ? `Token ${tokenId.slice(0, 12)}... cannot be finalized: ` +
              `${(err as Error)?.message ?? 'VerificationError'} (${innerMsg ?? 'recipient address mismatch'}). ` +
              `The sender targeted a recipient predicate that none of this wallet's currently-tracked ` +
              `HD addresses derive. Marked invalid; no further automatic recovery attempts will run for ` +
              `this token. If the sender targeted an HD index you have not yet activated, activate it ` +
              `and re-import the OrbitDB pointer to retry.`
            : `Token ${tokenId.slice(0, 12)}... cannot be finalized: ` +
              `${(err as Error)?.message ?? 'InvalidJsonStructureError'}. ` +
              `The stored last-transaction JSON or the aggregator proof has an unexpected shape. ` +
              `Marked invalid; no further automatic recovery attempts will run for this token. ` +
              `Manual diagnosis required — see debug logs for the shape dump.`;
          this.deps!.emitEvent('transfer:operator-alert', {
            code: alertCode,
            tokenId,
            message: sanitizeReasonString(alertMessage),
          });
        } catch { /* event emitter not wired */ }

        return;
      }

      // Non-structural error — keep current behaviour (log, return,
      // let the next polling tick retry). The polling tick's
      // PROOF_POLLING_MAX_ATTEMPTS cap eventually marks the token
      // invalid if the transient never resolves.
      logger.error('Payments', `[V6-RECOVER] Failed to finalize stranded receive ${tokenId.slice(0, 12)}:`, err);
    }
}

// ==============================================================================
// tryLocalFinalizeUnconfirmed
// ==============================================================================

export async function tryLocalFinalizeUnconfirmedImpl(this: any, 
    tokenId: string,
    token: Token,
    stClient: StateTransitionClient,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trustBase: any,
  ): Promise<'resolved' | 'failed' | 'stillPending' | 'skipped'> {
    if (!token.sdkData) return 'skipped';

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tokenJson: any;
    try {
      tokenJson = JSON.parse(token.sdkData);
    } catch {
      return 'skipped';
    }
    const txs: unknown[] = Array.isArray(tokenJson?.transactions)
      ? tokenJson.transactions
      : [];
    if (txs.length === 0) return 'skipped';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lastTxJson: any = txs[txs.length - 1];
    if (!lastTxJson || typeof lastTxJson !== 'object') return 'skipped';

    // Canonical default: missing inclusionProof === null.
    const lastTxProof =
      lastTxJson.inclusionProof === undefined ? null : lastTxJson.inclusionProof;
    if (lastTxProof === null) {
      // Genuinely pending — wait for proof to land via the proof-polling
      // queue. Not our case to fix.
      return 'stillPending';
    }

    // Source state at N-1 lives inside the last transfer tx's data.
    const sourceStateJson = lastTxJson.data?.sourceState;
    if (!sourceStateJson) return 'skipped';

    // Quick check: does the current state.predicate already match our
    // signing key? If yes, we're already finalized — no work needed.
    const ourSigningPk = this._signingPublicKeyHex;
    const currentStatePredicate = tokenJson?.state?.predicate;
    if (
      ourSigningPk !== null &&
      typeof currentStatePredicate === 'string' &&
      currentStatePredicate.toLowerCase().includes(ourSigningPk)
    ) {
      return 'skipped';
    }

    // **Critical**: predicate mismatch alone is NOT a signal that the
    // token is "meant for us". A token whose state.predicate doesn't
    // match our wallet could be:
    //   (a) meant for us but un-finalized (the case we want to fix), OR
    //   (b) meant for someone else (in which case applying our predicate
    //       would corrupt the chain and the SDK would reject it
    //       downstream, but only after on-chain side-effects).
    // Distinguish by inspecting the transfer transaction's `data.recipient`
    // — only proceed when it matches one of OUR destination addresses:
    //   - identity.directAddress (DIRECT:// scheme), OR
    //   - any PROXY:// derived from a nametag we hold (handled via
    //     `proxyAddressCache`, primed at load time from `this.nametags`).
    //
    // #207 PR-B — `recipient` is canonically a string in the SDK shape;
    // legacy wallet-local serializations sometimes wrap it as
    // `{address: string}`. Accept both.
    const recipientField: unknown = lastTxJson.data?.recipient;
    const recipientAddr: unknown =
      typeof recipientField === 'string'
        ? recipientField
        : (recipientField && typeof recipientField === 'object'
            ? (recipientField as { address?: unknown }).address
            : undefined);
    if (typeof recipientAddr !== 'string' || recipientAddr.length === 0) {
      return 'skipped';
    }
    const ourDirect = this.deps!.identity.directAddress;
    const isOurDirect =
      typeof ourDirect === 'string' && recipientAddr === ourDirect;
    const isOurProxy =
      recipientAddr.startsWith('PROXY://') &&
      this.proxyAddressCache.has(recipientAddr);
    if (!isOurDirect && !isOurProxy) {
      // Not addressed to us — don't try to finalize it. Could be a
      // token someone else's bundle smuggled past dedup, or a token we
      // accidentally retain from a prior identity (unlikely but
      // defensive). Skip silently.
      return 'skipped';
    }

    // Reconstruct sourceToken at state N-1.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let sourceToken: SdkToken<any>;
    let transferTx: TransferTransaction;
    try {
      const sourceTokenJson = {
        ...tokenJson,
        state: sourceStateJson,
        transactions: txs.slice(0, -1),
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sourceToken = await SdkToken.fromJSON(sourceTokenJson) as SdkToken<any>;
      transferTx = await TransferTransaction.fromJSON(lastTxJson);
    } catch (err) {
      logger.debug(
        'Payments',
        `[LOCAL-FINALIZE] ${tokenId.slice(0, 16)}: parse failed (${err instanceof Error ? err.message : String(err)})`,
      );
      return 'skipped';
    }

    try {
      const finalizedToken = await this.finalizeTransferToken(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sourceToken as any,
        transferTx,
        stClient,
        trustBase,
      );
      const finalizedSdkData = JSON.stringify(finalizedToken.toJSON());
      const updatedToken: Token = {
        ...token,
        status: 'confirmed',
        updatedAt: Date.now(),
        sdkData: finalizedSdkData,
      };
      this.tokens.set(tokenId, updatedToken);

      // Rebuild parsed-cache entry so the spend planner sees the new
      // confirmed balance immediately.
      try {
        const amount = this.extractCoinAmountForCache(
          finalizedToken,
          token.coinId,
        );
        if (amount > 0n) {
          this.parsedTokenCache.set(tokenId, {
            token: updatedToken,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sdkToken: finalizedToken as any,
            amount,
          });
          this.spendQueue.notifyChange(token.coinId);
        }
      } catch {
        // Non-fatal — the next reload rebuilds the cache.
      }

      logger.debug(
        'Payments',
        `[LOCAL-FINALIZE] ${tokenId.slice(0, 16)}: SUCCESS — state.predicate flipped to recipient`,
      );
      return 'resolved';
    } catch (err) {
      logger.debug(
        'Payments',
        `[LOCAL-FINALIZE] ${tokenId.slice(0, 16)}: finalize threw (${err instanceof Error ? err.message : String(err)}) — staying pending for retry`,
      );
      return 'failed';
    }
}

// ==============================================================================
// resolveLegacyReceivedToken
// ==============================================================================

export async function resolveLegacyReceivedTokenImpl(this: any, 
    tokenId: string,
    _token: Token,
  ): Promise<'resolved' | 'stillPending' | 'failed'> {
    const job = this.proofPollingJobs.get(tokenId);
    if (!job || !job.sourceTokenJson) {
      // No job: stranded (#144 L3 migration handles via
      // recoverStrandedReceivedTokens at load time). Don't fail here —
      // just report stillPending so the periodic retry stays calm.
      return 'stillPending';
    }

    // Steelman FIX D (#144): recovery jobs (registered by
    // `recoverStrandedReceivedTokens`) carry `commitmentJson: ''` — we
    // can't reconstruct the sender's authenticator, so the polling queue
    // uses the `getProof(requestIdHex)` fallback for them. Mirror that
    // here. Pre-FIX-D, `JSON.parse('')` threw, the outer catch swallowed
    // it, and this 10s defense-in-depth retry was a silent no-op for the
    // exact migration scenario it was meant to cover.
    if (!job.commitmentJson) {
      return await this.resolveLegacyReceivedTokenViaGetProof(tokenId, job);
    }

    try {
      const commitmentInput = JSON.parse(job.commitmentJson);
      const commitment = await TransferCommitment.fromJSON(commitmentInput);

      if (!this.deps!.oracle.waitForProofSdk) {
        // Can't poll for proof; rely on the background queue and any
        // explicit finalize callers (already handled in finalizeReceivedToken).
        return 'stillPending';
      }

      // Short timeout — resolveUnconfirmed is called every 10s; we don't
      // want to block other tokens in the loop.
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 500);
      let inclusionProof: unknown = null;
      try {
        inclusionProof = await Promise.race([
          this.deps!.oracle.waitForProofSdk(commitment, abortController.signal),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
        ]);
      } catch {
        // Aggregator timeout / no proof yet — let the next tick try again.
        clearTimeout(timeoutId);
        return 'stillPending';
      }
      clearTimeout(timeoutId);

      if (!inclusionProof) return 'stillPending';

      // Proof landed — finalize. `finalizeReceivedToken` writes through to
      // `this.tokens` and persists via `save()`. It also emits the
      // `transfer:confirmed` event.
      let sourceTokenInput: unknown;
      try {
        sourceTokenInput = JSON.parse(job.sourceTokenJson);
      } catch (err) {
        logger.error(
          'Payments',
          `[V6-RESOLVE] Failed to parse stored sourceTokenJson for ${tokenId.slice(0, 12)}:`,
          err,
        );
        return 'failed';
      }
      await this.finalizeReceivedToken(tokenId, sourceTokenInput, commitmentInput);

      // Clean up the proof-polling job — finalizeReceivedToken doesn't
      // remove it (the background queue normally does). Persist the
      // updated map.
      this.proofPollingJobs.delete(tokenId);
      this.saveProofPollingJobs().catch((err: unknown) =>
        logger.debug('Payments', '[V6-PERSIST] saveProofPollingJobs after resolve failed:', err),
      );

      return 'resolved';
    } catch (err) {
      logger.debug(
        'Payments',
        `[V6-RESOLVE] Error resolving legacy receive ${tokenId.slice(0, 12)}: ${(err as Error)?.message ?? err}`,
      );
      return 'stillPending';
    }
}

// ==============================================================================
// resolveLegacyReceivedTokenViaGetProof
// ==============================================================================

export async function resolveLegacyReceivedTokenViaGetProofImpl(this: any, 
    tokenId: string,
    job: any,
  ): Promise<'resolved' | 'stillPending' | 'failed'> {
    try {
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), 500);
      let proofResult: unknown = null;
      try {
        proofResult = await Promise.race([
          this.deps!.oracle.getProof(job.requestIdHex),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
        ]);
      } catch {
        clearTimeout(timeoutId);
        return 'stillPending';
      }
      clearTimeout(timeoutId);
      if (!proofResult) return 'stillPending';

      // The recovery callback (`finalizeStrandedReceivedToken`) does the
      // actual patch+finalize using `sourceTokenJson` + the cached
      // lastTxJson it closed over at registration time. Don't reimplement
      // that here — just invoke the callback.
      if (!job.onProofReceived) return 'failed';
      await job.onProofReceived(tokenId);

      // Clean up; `finalizeStrandedReceivedToken` doesn't remove the job.
      this.proofPollingJobs.delete(tokenId);
      this.saveProofPollingJobs().catch((err: unknown) =>
        logger.debug('Payments', '[V6-PERSIST] saveProofPollingJobs after recovery resolve failed:', err),
      );
      return 'resolved';
    } catch (err) {
      logger.debug(
        'Payments',
        `[V6-RESOLVE] Error resolving recovery job ${tokenId.slice(0, 12)}: ${(err as Error)?.message ?? err}`,
      );
      return 'stillPending';
    }
}

// ==============================================================================
// parsePendingFinalization
// ==============================================================================

export function parsePendingFinalizationImpl(this: any, sdkData: string | undefined): PendingV5Finalization | null {
    if (!sdkData) return null;
    try {
      const data = JSON.parse(sdkData);
      if (data._pendingFinalization && data._pendingFinalization.type === 'v5_bundle') {
        return data._pendingFinalization as PendingV5Finalization;
      }
      return null;
    } catch {
      return null;
    }
}

// ==============================================================================
// updatePendingFinalization
// ==============================================================================

export function updatePendingFinalizationImpl(this: any, token: Token, pending: PendingV5Finalization): void {
    let sdkDataJson: string;
    try {
      const existing = token.sdkData ? JSON.parse(token.sdkData) : null;
      if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        sdkDataJson = JSON.stringify({ ...existing, _pendingFinalization: pending });
      } else {
        sdkDataJson = JSON.stringify({ _pendingFinalization: pending });
      }
    } catch {
      // Corrupted sdkData — fall back to legacy opaque shape (avoids
      // a hard failure mid-resolve; the bundleJson legacy path can
      // still finalize the token).
      sdkDataJson = JSON.stringify({ _pendingFinalization: pending });
    }

    const updated: Token = {
      id: token.id,
      coinId: token.coinId,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      iconUrl: token.iconUrl,
      amount: token.amount,
      status: token.status,
      createdAt: token.createdAt,
      updatedAt: Date.now(),
      sdkData: sdkDataJson,
    };
    this.tokens.set(token.id, updated);
}

// ==============================================================================
// savePendingV5Tokens
// ==============================================================================

export async function savePendingV5TokensImpl(this: any): Promise<void> {
    const pendingTokens: Token[] = [];
    for (const token of this.tokens.values()) {
      if (this.parsePendingFinalization(token.sdkData)) {
        pendingTokens.push(token);
      }
    }
    if (pendingTokens.length === 0) {
      logger.debug('Payments', `[V5-PERSIST] No pending V5 tokens to save (total tokens: ${this.tokens.size}), clearing KV`);
      // Clearing the pending set is operational cleanup after the
      // inbound transfer(s) finalized; not itself a user action.
      await this.setStorageEntry(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS, '', 'cache_index');
      this._lastPinnedV5Json = null;
      this._lastPinnedV5Ref = null;
      return;
    }

    // PROFILE-CID-REFERENCES.md §8.1 — pendingV5 tokens are fat (sdkData
    // can be 5-20 KB per token). When a CidRefStore is available, write
    // a small CID reference to OpLog and pin the content to IPFS. Falls
    // back to legacy inline JSON when CidRefStore is absent.
    const cidRefStore = this.deps!.cidRefStore;
    if (cidRefStore) {
      // Sort keys for deterministic JSON — two consecutive saves with the
      // same token set produce identical JSON regardless of Map insertion order.
      const json = JSON.stringify(pendingTokens);

      // Memoization: skip pin if plaintext is unchanged since last save.
      // AES-GCM uses random IVs so re-pinning identical plaintext would
      // produce a different CID anyway, but we'd rather write the same
      // ref than thrash the gateway.
      if (this._lastPinnedV5Ref && this._lastPinnedV5Json === json) {
        const refStr = CidRefStore.stringifyRef(this._lastPinnedV5Ref);
        logger.debug(
          'Payments',
          `[V5-PERSIST] Pending set unchanged, reusing cached CID ref (cid=${this._lastPinnedV5Ref.cid})`,
        );
        await this.setStorageEntry(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS, refStr, 'token_receive');
        return;
      }

      const ref = await cidRefStore.pinJson(pendingTokens);
      const refStr = CidRefStore.stringifyRef(ref);
      logger.debug(
        'Payments',
        `[V5-PERSIST] Saving ${pendingTokens.length} pending V5 token(s) via CID ref (cid=${ref.cid}, encryptedSize=${ref.size} bytes, OpLog value=${refStr.length} bytes)`,
      );
      await this.setStorageEntry(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS, refStr, 'token_receive');
      // Update memo AFTER successful storage.set so a set-failure does
      // not leave us thinking the CID is live.
      this._lastPinnedV5Json = json;
      this._lastPinnedV5Ref = ref;
      return;
    }

    // Legacy path: inline JSON (deprecated for heavy wallets — see CID-refs doc).
    const json = JSON.stringify(pendingTokens);
    logger.debug(
      'Payments',
      `[V5-PERSIST] Saving ${pendingTokens.length} pending V5 token(s) inline (${json.length} bytes — consider providing cidRefStore)`,
    );
    await this.setStorageEntry(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS, json, 'token_receive');
}

// ==============================================================================
// loadPendingV5Tokens
// ==============================================================================

export async function loadPendingV5TokensImpl(this: any): Promise<void> {
    const data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS);
    logger.debug('Payments', `[V5-PERSIST] loadPendingV5Tokens: KV data = ${data ? `${data.length} bytes` : 'null/empty'}`);
    if (!data) return;

    const ref = CidRefStore.tryParseRef(data);
    let pendingTokens: Token[];

    if (ref) {
      // CID reference path.
      if (!this.deps!.cidRefStore) {
        // Configuration error: a prior session wrote CID refs, this session
        // doesn't have the store needed to resolve them. Throw typed error
        // so the caller can surface to the user rather than silently
        // dropping pending transfers.
        const { ProfileError } = await import('../../../extensions/uxf/profile/errors.js');
        throw new ProfileError(
          'CID_REF_UNREADABLE',
          `this.loadPendingV5Tokens: KV at ${STORAGE_KEYS_ADDRESS.PENDING_V5_TOKENS} ` +
            `contains a CID ref (cid=${ref.cid}) but no cidRefStore was injected. ` +
            `Pending V5 transfers cannot be restored without IPFS access. ` +
            `Check PaymentsModule init — is cidRefStore provided?`,
        );
      }
      logger.debug(
        'Payments',
        `[V5-PERSIST] Reading via CID ref (cid=${ref.cid}, encryptedSize=${ref.size})`,
      );
      // Errors from fetchJson (IPFS timeout, CID_REF_SIZE_MISMATCH,
      // DECRYPTION_FAILED) propagate — NOT caught below.
      pendingTokens = await (this.deps!.cidRefStore as any).fetchJson(ref) as Token[];
    } else {
      // Legacy path: inline JSON (pre-CID-refs wallet). Narrow catch:
      // ONLY swallow SyntaxError from malformed legacy JSON. All other
      // errors propagate with their typed codes.
      try {
        pendingTokens = JSON.parse(data) as Token[];
      } catch (err) {
        if (err instanceof SyntaxError) {
          logger.error('Payments', '[V5-PERSIST] Legacy JSON parse failed (corrupted inline data):', err);
          return;
        }
        throw err;
      }
    }

    if (!Array.isArray(pendingTokens)) {
      // Defensive: a legacy wallet's JSON was the wrong shape.
      logger.error(
        'Payments',
        `[V5-PERSIST] Decoded pendingTokens is not an array (got ${typeof pendingTokens}); skipping load.`,
      );
      return;
    }

    logger.debug(
      'Payments',
      `[V5-PERSIST] Parsed ${pendingTokens.length} pending V5 token(s): ${pendingTokens.map((t) => t.id.slice(0, 16)).join(', ')}`,
    );
    for (const token of pendingTokens) {
      // Only restore if not already in the map (e.g., already resolved)
      if (!this.tokens.has(token.id)) {
        this.tokens.set(token.id, token);
        logger.debug('Payments', `[V5-PERSIST] Restored token ${token.id.slice(0, 16)} (status=${token.status})`);
      } else {
        logger.debug('Payments', `[V5-PERSIST] Token ${token.id.slice(0, 16)} already in map, skipping`);
      }
    }
}

// ==============================================================================
// saveProcessedSplitGroupIds
// ==============================================================================

export async function saveProcessedSplitGroupIdsImpl(this: any): Promise<void> {
    const ids = Array.from(this.processedSplitGroupIds);
    if (ids.length > 0) {
      // Dedup ledger — operational state protecting against duplicate
      // Nostr re-deliveries; not itself a user action.
      await this.setStorageEntry(
        STORAGE_KEYS_ADDRESS.PROCESSED_SPLIT_GROUP_IDS,
        JSON.stringify(ids),
        'cache_index',
      );
    }
}

// ==============================================================================
// loadProcessedSplitGroupIds
// ==============================================================================

export async function loadProcessedSplitGroupIdsImpl(this: any): Promise<void> {
    const data = await this.deps!.storage.get(STORAGE_KEYS_ADDRESS.PROCESSED_SPLIT_GROUP_IDS);
    if (!data) return;
    try {
      const ids = JSON.parse(data) as string[];
      for (const id of ids) {
        this.processedSplitGroupIds.add(id);
      }
    } catch {
      // Ignore corrupt data
    }
}

// ==============================================================================
// finalizeTransferToken
// ==============================================================================

export async function finalizeTransferTokenImpl(this: any, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sourceToken: SdkToken<any>,
    transferTx: TransferTransaction,
    stClient: StateTransitionClient,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trustBase: any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<SdkToken<any>> {
    const recipientAddress = transferTx.data.recipient;
    const addressScheme = recipientAddress.scheme;
    const transferSalt = transferTx.data.salt;

    // Resolve nametag tokens once — needed both for PROXY validation and
    // for resolving `transferTx.data.recipient` to its target DIRECT
    // address (so the HD-index recovery comparison below has the same
    // shape the SDK's `verifyRecipient` will compute).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let nametagTokens: SdkToken<any>[] = [];
    if (addressScheme === AddressScheme.PROXY) {
      const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
      let proxyNametag = this.getNametag();

      // Recovery: if nametag is missing in memory (e.g., wiped by sync or race
      // condition during address switch), try reloading from storage
      if (!proxyNametag?.token) {
        logger.debug('Payments', 'Unicity ID missing in memory, attempting reload from storage...');
        await this.reloadNametagsFromStorage();
        proxyNametag = this.getNametag();
      }

      if (!proxyNametag?.token) {
        throw new SphereError('Cannot finalize PROXY transfer - no Unicity ID token', 'VALIDATION_ERROR');
      }
      const nametagToken = await SdkToken.fromJSON(proxyNametag.token);
      const proxy = await ProxyAddress.fromTokenId(nametagToken.id);
      if (proxy.address !== recipientAddress.address) {
        throw new SphereError(
          `PROXY address mismatch: nametag resolves to ${proxy.address} ` +
          `but transfer targets ${recipientAddress.address}`,
          'VALIDATION_ERROR',
        );
      }
      nametagTokens = [nametagToken];
    }

    // Issue #255 Problem A — HD-index recovery for the post-#251
    // `Recipient address mismatch` residue. Fast path: try the current
    // active address's signing service first. If its derived recipient
    // address doesn't match what the sender wrote (and we have the
    // recovery deps wired), iterate tracked addresses to find a
    // signing service whose derived address DOES match. If still no
    // match, emit a diagnostic `warn` line and fall through to the
    // SDK error path so callers (V6-RECOVER, live-receive,
    // LOCAL-FINALIZE, UXF receive) keep their existing error
    // contract.
    const signingService = await this.createSigningService();
    const expectedTransactionAddress = await this.resolveExpectedTransactionAddress(
      recipientAddress,
      nametagTokens,
    );
    const primaryDerivedAddress = await this.deriveRecipientAddressFor(
      signingService,
      sourceToken,
      transferSalt,
    );

    let chosenSigner = signingService;
    let recoveredIndex: number | null = null;

    if (
      expectedTransactionAddress !== null &&
      primaryDerivedAddress !== null &&
      primaryDerivedAddress !== expectedTransactionAddress
    ) {
      const recovery = await this.tryRecoverSigningServiceForRecipient(
        sourceToken,
        transferSalt,
        expectedTransactionAddress,
      );
      if (recovery) {
        chosenSigner = recovery.signer;
        recoveredIndex = recovery.index;
        logger.warn(
          'Payments',
          `[FINALIZE-RECOVER] HD-index drift recovered for token ${this.shortHex(sourceToken.id.toString())}: ` +
          `currentSigner derived ${primaryDerivedAddress}, ` +
          `sender targeted ${expectedTransactionAddress}, ` +
          `matched at tracked HD index ${recoveredIndex}. ` +
          `Using that index's signing service for finalize.`,
        );
      } else {
        const triedIndices = this.deps?.getActiveAddresses?.()
          ?.map((a: any) => a.index)
          ?.join(',') ?? '<no-recovery-deps>';
        logger.warn(
          'Payments',
          `[FINALIZE-RECOVER] Recipient address mismatch with no recovery candidate ` +
          `(SDK will throw VerificationError next): ` +
          `tokenId=${this.shortHex(sourceToken.id.toString())} ` +
          `tokenType=${this.shortHex(sourceToken.type.toString())} ` +
          `salt=${this.shortHex(this.bytesToHexSafe(transferSalt))} ` +
          `addressScheme=${addressScheme} ` +
          `txRecipient=${recipientAddress.address} ` +
          `resolvedTxAddress=${expectedTransactionAddress} ` +
          `currentSignerExpected=${primaryDerivedAddress} ` +
          `triedIndices=[${triedIndices}]`,
        );
      }
    }

    const recipientPredicate = await UnmaskedPredicate.create(
      sourceToken.id,
      sourceToken.type,
      chosenSigner,
      HashAlgorithm.SHA256,
      transferSalt
    );
    const recipientState = new TokenState(recipientPredicate, null);

    return stClient.finalizeTransaction(
      trustBase,
      sourceToken,
      recipientState,
      transferTx,
      nametagTokens
    );
}

// ==============================================================================
// finalizeReceivedToken
// ==============================================================================

export async function finalizeReceivedTokenImpl(this: any, 
    tokenId: string,
    sourceTokenInput: unknown,
    commitmentInput: unknown,
  ): Promise<void> {
    try {
      const token = this.tokens.get(tokenId);
      if (!token) {
        logger.debug('Payments', `Token ${tokenId} not found for finalization`);
        return;
      }

      // Issue #389 finding #1 — the V6-RECOVER permanent ledger is
      // authoritative for "this wallet cannot finalize this token".
      // If a previous session stamped this tokenId as permanent (HD-
      // index recovery exhausted / structural failure), a restored
      // proof-polling job from `restoreProofPollingJobs` (or a stale
      // in-memory job left over from before the verdict landed) would
      // otherwise call into this method, succeed in fetching a proof,
      // and overwrite the durable `'invalid'` status with `'confirmed'`
      // — exactly the regression #387 closed. The `restoreV6RecoverPermanent`-
      // before-`restoreProofPollingJobs` ordering fix on `load()` closes
      // the cold-start race for fresh jobs, but a process that picks up
      // a job mid-flight, or a future caller that bypasses the load
      // ordering, would still hit this method. The ledger consult here
      // is the belt to that braces.
      if (this.isV6RecoverPermanentToken(token, tokenId)) {
        logger.debug(
          'Payments',
          `[V6-RECOVER-PERM] Skipping finalize for ${tokenId.slice(0, 12)}... ` +
            `— token is on the permanent-verdict ledger; status stays 'invalid'`,
        );
        // Best-effort cleanup of the polling job so subsequent ticks
        // don't keep firing this no-op path.
        if (this.proofPollingJobs.delete(tokenId)) {
          this.saveProofPollingJobs().catch((persistErr: unknown) =>
            logger.debug(
              'Payments',
              `[V6-RECOVER-PERM] saveProofPollingJobs after ledger-skip failed:`,
              persistErr,
            ),
          );
        }
        return;
      }

      // Get proof from aggregator
      const commitment = await TransferCommitment.fromJSON(commitmentInput);
      if (!this.deps!.oracle.waitForProofSdk) {
        // R20 fix: do NOT mark confirmed when finalization can't complete.
        // The token's sdkData still holds the SENDER's state (sender's
        // predicate). Marking 'confirmed' here would let the spend queue
        // pick it for outbound transfers; the resulting commitment's
        // sourceState.predicate would be the sender's pubkey, the
        // authenticator would be ours — predicate.isOwner() returns false
        // and the aggregator throws "Authenticator does not match source
        // state predicate." Leaving status='submitted' makes the spend
        // queue's `status !== 'confirmed'` filter (SpendQueue.ts:91)
        // skip this token until proof+finalize complete.
        logger.warn('Payments', `Cannot finalize - no waitForProofSdk; leaving token ${tokenId.slice(0, 12)}... in 'submitted' status`);
        return;
      }

      const inclusionProof = await this.deps!.oracle.waitForProofSdk(commitment);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const transferTx = commitment.toTransaction(inclusionProof as any);

      // Parse source token
      const sourceToken = await SdkToken.fromJSON(sourceTokenInput);

      // Get state transition client
      const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trustBase = (this.deps!.oracle as any).getTrustBase?.();

      if (!stClient || !trustBase) {
        // R20 fix: same rationale as above — do NOT mark confirmed when
        // we can't normalize sdkData to OUR predicate. The spend queue
        // must keep skipping this token.
        logger.warn('Payments', `Cannot finalize - missing stClient/trustBase; leaving token ${tokenId.slice(0, 12)}... in 'submitted' status`);
        return;
      }

      // Finalize using shared helper (handles PROXY address validation)
      const finalizedSdkToken = await this.finalizeTransferToken(
        sourceToken, transferTx, stClient, trustBase
      );

      // Update token with finalized data (create new token with updated sdkData)
      const finalizedToken: Token = {
        ...token,
        status: 'confirmed',
        updatedAt: Date.now(),
        sdkData: JSON.stringify(finalizedSdkToken.toJSON()),
      };
      this.tokens.set(tokenId, finalizedToken);
      await this.save();

      // Spend Queue: cache newly confirmed token and wake queued entries
      const nostrAmount = this.extractCoinAmountForCache(finalizedSdkToken, finalizedToken.coinId);
      if (nostrAmount > 0n) {
        this.parsedTokenCache.set(tokenId, { token: finalizedToken, sdkToken: finalizedSdkToken, amount: nostrAmount });
        this.spendQueue.notifyChange(finalizedToken.coinId);
      }

      logger.debug('Payments', `NOSTR-FIRST: Token ${tokenId.slice(0, 8)}... finalized and confirmed`);

      // Emit confirmation event
      this.deps!.emitEvent('transfer:confirmed', {
        id: crypto.randomUUID(),
        status: 'completed',
        tokens: [finalizedToken],
        tokenTransfers: [],
      });

      // History entry was already created in handleCommitmentOnlyTransfer() — no duplicate here
    } catch (error) {
      // R20 fix (PR #130) + #144 steelman FIX H (PR #146): do NOT mark
      // confirmed when finalize throws.
      //
      // Pre-fix, this catch unconditionally flipped status to 'confirmed'
      // — "user has the token" — but `sdkData` was never updated to the
      // finalized state. Any subsequent spend would build a commitment
      // with the SENDER's sourceState predicate while authenticator
      // carried THIS wallet's pubkey, and submitTransferCommitment
      // rejected with "Authenticator does not match source state
      // predicate." The flip also swallowed real integrity failures
      // (trustBase mismatch, predicate validation, invalid proof)
      // leaving a token-shaped placeholder in the active map that fails
      // every subsequent verification while counting toward balance.
      // The restart-recovery path (#144 L1 restoreProofPollingJobs)
      // widens this catch's reach, making the bug user-visible.
      //
      // Fixed behavior: leave the token at its current status (typically
      // 'submitted'/'pending' so the polling queue retries) and emit a
      // typed operator-alert so the UI / support has a signal.
      logger.error('Payments', `Failed to finalize received token ${tokenId.slice(0, 12)}... — leaving status for retry:`, error);
      try {
        this.deps!.emitEvent('transfer:operator-alert', {
          // `proof-throw` matches §5.4's "proof verify threw" — closest
          // canonical DispositionReason for a finalize-side failure that
          // we can't cleanly attribute to one of the structural codes.
          code: 'proof-throw',
          tokenId,
          message:
            `finalizeReceivedToken threw for ${tokenId.slice(0, 12)}...: ` +
            `${(error as Error)?.message ?? String(error)}. ` +
            `Token left at current status for retry by the polling queue.`,
        });
      } catch {
        // Event emitter not wired — log only.
      }
      // Intentionally do NOT mutate token.status here.
    }
}
