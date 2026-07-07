/**
 * @internal Phase 5 [C] quarantine — Phase 6.C deletes this file wholesale.
 *
 * V5 unconfirmed / commitment-only save helpers. `saveUnconfirmedV5Token`
 * and `saveCommitmentOnlyToken` are v1-STSDK receiver-side persistence
 * paths superseded by the v2 engine's "tokens arrive finished" semantics.
 */

import type { Token } from '../../../types';
import type {
  InstantSplitBundleV5,
  PendingV5Finalization,
} from '../../../types/instant-split';
import { logger } from '../../../core/logger';
import { TokenRegistry } from '../../../registry';
import {
  buildSyntheticV5PendingSdkData,
} from '../v5-pending-shape';
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import {
  extractTokenIdFromSdkData,
  extractStateHashFromSdkData,
} from '../tokens';

// The parseTokenInfo helper is a module-local function inside
// PaymentsModule.ts (line ~453). We import it via a small runtime shim
// that the facade will pass through as `this.__parseTokenInfo` — but
// simpler: replicate the call by importing the same source utilities.
// However, the callsite uses parseTokenInfo which is a local module
// function. We inline via a `this.__parseTokenInfo` accessor added on
// the facade side; to avoid adding one, we duplicate the small shim.
// The cleanest path is to reference the module-scope function through
// `this.constructor` won't work — so we re-implement below via
// requesting the facade to pass parseTokenInfo through `this.parseTokenInfo`.
// For minimal disruption, we accept a runtime dep: extract via a
// dynamic-ish `require` isn't valid in ESM either. Instead: we call
// the same underlying parser via the facade-level helper
// `this.parseTokenInfoAny` — added below as a facade shim.

/**
 * Save a V5 split bundle as an unconfirmed token (shared by V5 standalone
 * and V6 combined). Returns the created UI token, or null if deduped.
 */
export async function saveUnconfirmedV5TokenImpl(
  this: any,
  bundle: InstantSplitBundleV5,
  senderPubkey: string,
  deferPersistence = false,
): Promise<Token | null> {
    const deterministicId = `v5split_${bundle.splitGroupId}`;
    if (this.tokens.has(deterministicId) || this.processedSplitGroupIds.has(bundle.splitGroupId)) {
      logger.debug('Payments', `V5 bundle ${bundle.splitGroupId.slice(0, 12)}... already processed, skipping`);
      return null;
    }

    const registry = TokenRegistry.getInstance();
    const pendingData: PendingV5Finalization = {
      type: 'v5_bundle',
      stage: 'RECEIVED',
      bundleJson: JSON.stringify(bundle),
      senderPubkey,
      savedAt: Date.now(),
      attemptCount: 0,
    };

    // #202 — Build a UXF/TXF-valid synthetic sdkData. See doc-comment.
    // On any parse failure, fall back to the legacy opaque
    // `{_pendingFinalization: ...}` shape (single-device KV path still
    // recovers the token; bundle CAR omits it as pre-#202).
    //
    // #207 PR-B — helper extracted to `v5-pending-shape.ts` for unit
    // testability + clear separation of pure shape-construction from
    // wallet-side bookkeeping. The helper returns a discriminated result
    // so the fallback log carries the underlying error message — silent
    // regressions in bundle shape are otherwise undiagnosable.
    let sdkDataJson: string;
    const syntheticResult = buildSyntheticV5PendingSdkData(bundle, pendingData);
    if (syntheticResult.ok) {
      sdkDataJson = syntheticResult.sdkData;
    } else {
      logger.warn(
        'Payments',
        `saveUnconfirmedV5Token: failed to synthesize UXF-compatible shape for bundle ${bundle.splitGroupId.slice(0, 12)} (${syntheticResult.error}), falling back to legacy opaque shape — token will be omitted from bundle CAR but recoverable via PENDING_V5_TOKENS KV`,
      );
      sdkDataJson = JSON.stringify({ _pendingFinalization: pendingData });
    }

    const uiToken: Token = {
      id: deterministicId,
      coinId: bundle.coinId,
      symbol: registry.getSymbol(bundle.coinId) || bundle.coinId,
      name: registry.getName(bundle.coinId) || bundle.coinId,
      decimals: registry.getDecimals(bundle.coinId) ?? 8,
      amount: bundle.amount,
      status: 'submitted',  // UNCONFIRMED
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: sdkDataJson,
    };

    // Record splitGroupId for persistent dedup across page reloads
    this.processedSplitGroupIds.add(bundle.splitGroupId);

    if (deferPersistence) {
      // Only update in-memory map — caller will save() + saveProcessedSplitGroupIds()
      this.tokens.set(uiToken.id, uiToken);
    } else {
      await this.addToken(uiToken);
      await this.saveProcessedSplitGroupIds();
    }

    return uiToken;
  }

/**
 * Save a commitment-only (NOSTR-FIRST) token and start proof polling.
 * Shared by standalone NOSTR-FIRST handler and V6 combined handler.
 */
export async function saveCommitmentOnlyTokenImpl(
  this: any,
  sourceTokenInput: unknown,
  commitmentInput: unknown,
  senderPubkey: string,
  deferPersistence = false,
  skipGenesisDedup = false,
): Promise<Token | null> {
    const tokenInfo = await this.__parseTokenInfo(sourceTokenInput);

    // V6-RECV / faucet-flow fix (post PR #146 regression).
    //
    // Pre-fix, this method persisted the raw source TXF as-is. The
    // bundle's source token carries only the mint transaction (with its
    // own inclusionProof). The transfer commitment that flips ownership
    // to us is tracked separately as a proof-polling job in
    // `this.proofPollingJobs`. After a CLI invocation exits and a new
    // one runs:
    //
    //  - `determineTokenStatus` sees "1 tx with proof" → 'confirmed'
    //    (the original in-memory 'submitted' status is lost).
    //  - The proof-polling job persistence is fire-and-forget and may
    //    not complete before process exit; even when it does,
    //    `restoreProofPollingJobs` runs AFTER `loadFromStorageData`.
    //  - PR #146's `#144 L3 balance-model invariant` then moves the
    //    token to archive because the state.predicate is the sender's,
    //    not ours, AND `hasFinalizationPlan()` returns false.
    //
    // Net effect: faucet (and any V6 direct) receives become invisible
    // after the first CLI exit. The user sees "No tokens found" even
    // though tokens are on disk and history records the inbound.
    //
    // Fix: synthesize a pending transfer transaction in the persisted
    // sdkData using the commitment's transactionData with
    // `inclusionProof: null`. After this, the on-disk shape correctly
    // expresses "received but transfer not yet finalized" via the
    // standard pending-tx convention that V5 splits and other paths
    // already use:
    //
    //   - `determineTokenStatus` sees last tx with null proof → 'pending'.
    //   - `isReceivedLegacyPending(token)` returns true (recipient is us).
    //   - `hasFinalizationPlan(token)` returns true.
    //   - The balance-model invariant correctly skips archive.
    //   - `recoverStrandedReceivedTokens` recovers a fresh proof-polling
    //     job on next load.
    //
    // When `finalizeReceivedToken` runs (now or after restart), it
    // calls `finalizeTransferToken` which rebuilds the transactions
    // array from the SDK — the synthetic pending tx is replaced by the
    // proven one in finalizeTransferToken's output.
    let sdkData: string;
    {
      const rawSource: unknown =
        typeof sourceTokenInput === 'string'
          ? JSON.parse(sourceTokenInput)
          : sourceTokenInput;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rawSourceObj = rawSource as any;
      const existingTxs: unknown[] = Array.isArray(rawSourceObj?.transactions)
        ? rawSourceObj.transactions
        : [];

      // Extract the commitment's transactionData AND authenticator. The
      // commitment is either a parsed object or a JSON-ish object; the
      // `transactionData` sub-object is what goes on-chain. We use it to
      // synthesize a pending tx with `inclusionProof: null` so subsequent
      // loads see a properly-shaped "transfer pending" token.
      //
      // Option B (token-local recovery state): we also embed the sender's
      // `authenticator` under a wallet-internal `_wallet` field on the
      // synthetic pending tx. The authenticator is the SENDER's signature
      // over (transactionHash, sourceStateHash) — the aggregator verifies
      // it without caring about the submitter's identity. Storing it
      // alongside the transactionData lets the recipient re-submit the
      // commitment after a wallet wipe + re-import-from-mnemonic, without
      // any cooperation from the (possibly offline) sender. This closes
      // the gap where proof-polling jobs (kept in a separate KV map, not
      // in the IPFS-published TXF) get lost on profile recreation.
      //
      // `_wallet` is a non-SDK field; `normalizeSdkTokenToStorage` uses
      // structuredClone, which preserves unknown fields. On finalize,
      // `SdkToken.fromJSON` strips it (typed deserialization), and
      // `finalizedSdkToken.toJSON()` writes the clean post-transition
      // shape — so `_wallet` is naturally cleaned up.
      let pendingTxData: unknown = null;
      let pendingAuthenticator: unknown = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ci = commitmentInput as any;
        if (ci && typeof ci === 'object') {
          if (ci.transactionData !== undefined) {
            pendingTxData = ci.transactionData;
          } else if (ci.data !== undefined) {
            pendingTxData = ci.data;
          }
          // Authenticator can come as plain JSON ({publicKey, signature,
          // stateHash}) or as a class instance with toJSON(). Normalize to
          // the JSON shape so the recovery path can pass it straight to
          // `TransferCommitment.fromJSON({...})`.
          if (ci.authenticator !== undefined && ci.authenticator !== null) {
            const auth = ci.authenticator as { toJSON?: () => unknown };
            pendingAuthenticator =
              typeof auth.toJSON === 'function' ? auth.toJSON() : ci.authenticator;
          }
        }
      } catch {
        // Best-effort — fall through. The token will still be saved
        // (without the synthetic pending tx) and finalization will
        // recover the state when the proof arrives in this session.
        pendingTxData = null;
        pendingAuthenticator = null;
      }

      // Defensive: avoid double-appending. If the last existing tx already
      // has `inclusionProof: null` (or missing — see the parser tweaks in
      // `determineTokenStatus` / `isReceivedLegacyPending` which treat
      // missing as null per the canonical V5/V6 protocol), the source TXF
      // already encodes a pending transfer. Don't append a second one.
      const lastExistingTx = existingTxs[existingTxs.length - 1] as
        | { inclusionProof?: unknown }
        | undefined;
      const lastExistingHasNullProof =
        lastExistingTx !== undefined &&
        (lastExistingTx.inclusionProof === null ||
          lastExistingTx.inclusionProof === undefined);

      const syntheticPendingTx: Record<string, unknown> = {
        data: pendingTxData,
        inclusionProof: null,
      };
      if (pendingAuthenticator !== null) {
        // Wallet-internal recovery state — Option B (token-local).
        syntheticPendingTx._wallet = { authenticator: pendingAuthenticator };
      }

      const augmentedSource =
        pendingTxData !== null && !lastExistingHasNullProof
          ? {
              ...rawSourceObj,
              transactions: [...existingTxs, syntheticPendingTx],
            }
          : rawSourceObj;

      sdkData = JSON.stringify(augmentedSource);
    }

    // Check tombstones BEFORE creating the token
    const nostrTokenId = extractTokenIdFromSdkData(sdkData);
    const nostrStateHash = extractStateHashFromSdkData(sdkData);
    if (nostrTokenId && nostrStateHash && this.isStateTombstoned(nostrTokenId, nostrStateHash)) {
      logger.debug('Payments', `NOSTR-FIRST: Rejecting tombstoned token ${nostrTokenId.slice(0, 8)}..._${nostrStateHash.slice(0, 8)}...`);
      return null;
    }

    // Dedup: check existing tokens
    if (nostrTokenId) {
      for (const existing of this.tokens.values()) {
        const existingTokenId = extractTokenIdFromSdkData(existing.sdkData);
        if (existingTokenId !== nostrTokenId) continue;

        // Exact state match — always reject (duplicate delivery)
        const existingStateHash = extractStateHashFromSdkData(existing.sdkData);
        if (nostrStateHash && existingStateHash === nostrStateHash) {
          logger.debug(
            'Payments',
            `NOSTR-FIRST: Skipping duplicate token state ${nostrTokenId.slice(0, 8)}..._${nostrStateHash.slice(0, 8)}...`
          );
          return null;
        }

        // Same genesis, different state — reject for standalone NOSTR-FIRST (replay after
        // finalization changes stateHash), allow for V6 batches (split children share genesis)
        if (!skipGenesisDedup) {
          logger.debug(
            'Payments',
            `NOSTR-FIRST: Skipping replay of finalized token ${nostrTokenId.slice(0, 8)}...`
          );
          return null;
        }
      }
    }

    const token: Token = {
      id: crypto.randomUUID(),
      coinId: tokenInfo.coinId,
      symbol: tokenInfo.symbol,
      name: tokenInfo.name,
      decimals: tokenInfo.decimals,
      iconUrl: tokenInfo.iconUrl,
      amount: tokenInfo.amount,
      status: 'submitted',  // NOSTR-FIRST: unconfirmed until proof
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData,
    };

    // Add token to in-memory map
    this.tokens.set(token.id, token);

    if (!deferPersistence) {
      await this.save();
    }

    // Start proof polling (commitment submission deferred when batching)
    try {
      const commitment = await TransferCommitment.fromJSON(commitmentInput);
      const requestIdBytes = commitment.requestId;
      const requestIdHex = requestIdBytes instanceof Uint8Array
        ? Array.from(requestIdBytes).map(b => b.toString(16).padStart(2, '0')).join('')
        : (typeof (requestIdBytes as { toJSON?: () => string }).toJSON === "function" ? (requestIdBytes as { toJSON: () => string }).toJSON() : String(requestIdBytes));

      if (!deferPersistence) {
        // Submit commitment to aggregator immediately (standalone path)
        const stClient = this.deps!.oracle.getStateTransitionClient?.() as StateTransitionClient | undefined;
        if (stClient) {
          const response = await stClient.submitTransferCommitment(commitment);
          logger.debug('Payments', `NOSTR-FIRST recipient commitment submit: ${response.status}`);
        }
      }

      this.addProofPollingJob({
        tokenId: token.id,
        requestIdHex,
        commitmentJson: JSON.stringify(commitmentInput),
        // Persist the source token JSON so that on process restart we can
        // restore the job (#144 layer 1). `sdkData` is the raw source TXF
        // string — same value that was passed in as `sourceTokenInput`.
        sourceTokenJson: sdkData,
        startedAt: Date.now(),
        attemptCount: 0,
        lastAttemptAt: 0,
        onProofReceived: async (tokenId: string) => {
          await this.finalizeReceivedToken(tokenId, sourceTokenInput, commitmentInput);
        },
      });
    } catch (err) {
      logger.error('Payments', 'Failed to parse commitment for proof polling:', err);
    }

    return token;
  }
