/**
 * Source-token chain finalization (Issue #197).
 *
 * Single SDK routine that walks a {@link Token}'s `sdkData.transactions`
 * chain and attaches an aggregator inclusion proof to every entry whose
 * `inclusionProof` is `null` / missing. Returns a NEW {@link Token} when
 * any proof was attached (callers persist it); returns the same reference
 * when the chain was already fully finalized (no allocation).
 *
 * Why this is the SOLE chain-finalization routine: a local
 * `status === 'confirmed'` flag is INDEPENDENT of the
 * `sdkData.transactions[*].inclusionProof` completeness. A locally-
 * confirmed token can still carry proofless txs (e.g. via the recipient
 * dispositionWriter fallback flip from Issue #195, or via instant-mode
 * arrivals whose deferred worker never ran). The `Token.verify(trustBase)`
 * check the recipient performs walks EVERY tx in the chain — any null
 * proof rejects the whole token. So every wallet path that ships a token
 * to another party (conservative send, future TXF-conservative arm, swap
 * payout staging, etc.) MUST funnel through this routine before letting
 * the bundle leave the wire.
 *
 * Internally driven by {@link preflightFinalize}: per pending tx the
 * routine derives `(requestId, transactionHash)` from the tx data, probes
 * the aggregator (no re-submit — the previous owner already anchored the
 * commitment, this routine ONLY attaches the existing proof), and patches
 * the working `sdkData` JSON in lock-step. `SOURCE_CHAIN_HARD_FAIL`
 * propagates verbatim on irrecoverable rejection.
 *
 * Spec references:
 *  - `docs/uxf/UXF-TRANSFER-PROTOCOL.md` §2.2 (conservative full-history
 *    finalization-before-send).
 *  - Issue #197 — Conservative-mode sender ships proofless intermediate
 *    txs; recipient ingest silently wedges.
 *
 * @module modules/payments/transfer/conservative-source-finalize
 * @internal
 */

import { PredicateEngineService } from '@unicitylabs/state-transition-sdk/lib/predicate/PredicateEngineService';
import { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId';
import { TransferTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransactionData';

import type { OracleProvider } from '../../../oracle/oracle-provider';
import type { Token } from '../../../types';
import { preflightFinalize } from './preflight-finalize';

/**
 * One pending tx in a source token's chain. `txIndex` is the position
 * within `transactions` (so the proof can be patched into the right slot
 * later). `txData` is the raw `data` sub-object of the tx — the payload
 * that {@link TransferTransactionData.fromJSON} consumes.
 */
export interface PendingSourceTx {
  readonly txIndex: number;
  readonly txData: unknown;
}

/**
 * Walk a serialized SDK Token JSON string and return every tx whose
 * `inclusionProof` is `null` or missing, in source order (oldest first).
 *
 * Entries whose `data` is `null`/`undefined` are SKIPPED — they
 * represent the wallet-internal synthetic placeholder used during
 * transient send recovery (`PaymentsModule.ts` ~line 6237) and the
 * aggregator cannot resolve a proof for them. They are not in scope for
 * conservative pre-publish finalize.
 *
 * Returns `[]` for malformed JSON or non-array transactions — the caller
 * no-ops in that case.
 */
export function extractPendingChainFromSdkData(sdkDataJson: string): PendingSourceTx[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sdkDataJson);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const transactions = (parsed as { readonly transactions?: unknown[] }).transactions;
  if (!Array.isArray(transactions)) return [];

  const out: PendingSourceTx[] = [];
  for (let i = 0; i < transactions.length; i++) {
    const tx = transactions[i];
    if (tx === null || typeof tx !== 'object') continue;
    const proof = (tx as { readonly inclusionProof?: unknown }).inclusionProof;
    if (proof !== null && proof !== undefined) continue;
    const data = (tx as { readonly data?: unknown }).data;
    if (data === null || data === undefined) continue;
    out.push({ txIndex: i, txData: data });
  }
  return out;
}

/**
 * Walk a {@link Token}'s `sdkData.transactions` chain. Thin wrapper
 * around {@link extractPendingChainFromSdkData}.
 *
 * Returns `[]` for tokens without `sdkData`.
 */
export function extractPendingSourceChain(token: Token): PendingSourceTx[] {
  if (token.sdkData === undefined || typeof token.sdkData !== 'string') {
    return [];
  }
  return extractPendingChainFromSdkData(token.sdkData);
}

/**
 * Derive `(requestId, transactionHash)` for a single pending source tx.
 *
 * `requestId` uses the SDK's canonical construction
 * `RequestId.create(senderPubkey, sourceStateHash)`; `senderPubkey` is
 * extracted from the source-state predicate via
 * `PredicateEngineService.createPredicate`. `transactionHash` is the SDK
 * `DataHash` imprint of the tx data (matches what the aggregator anchors
 * in `proof.transactionHash`).
 *
 * Throws if the predicate type does not expose a publicKey (only
 * `MaskedPredicate` / `UnmaskedPredicate` do). A throw is treated by
 * {@link preflightFinalize} as a `client-error` hard-fail and the
 * conservative send is aborted before any on-chain action.
 *
 * Mirrors the canonical derivation at `PaymentsModule.ts` ~line 2516
 * (recipient ingest path). Kept in lockstep so a future SDK shape change
 * updates both at once.
 */
export async function derivePendingTxDescriptor(
  pendingTx: PendingSourceTx,
): Promise<{ readonly requestId: string; readonly transactionHash: string }> {
  const data = pendingTx.txData;
  if (data === null || data === undefined || typeof data !== 'object') {
    throw new Error(
      `derivePendingTxDescriptor: pendingTx at index ${pendingTx.txIndex} has null/non-object data`,
    );
  }
  const txData = await TransferTransactionData.fromJSON(data);
  const txDataHash = await txData.calculateHash();
  const transactionHash = txDataHash.toJSON();

  const senderPredicate = await PredicateEngineService.createPredicate(
    txData.sourceState.predicate,
  );
  const senderPubkey = (senderPredicate as unknown as { publicKey?: Uint8Array }).publicKey;
  if (!(senderPubkey instanceof Uint8Array) || senderPubkey.length === 0) {
    const engineStr = String(
      (senderPredicate as unknown as { engine?: unknown }).engine ?? 'unknown',
    );
    throw new Error(
      `Source predicate (engine=${engineStr}) at tx index ${pendingTx.txIndex} ` +
        'does not expose a publicKey — cannot derive requestId',
    );
  }
  const sourceStateHash = await txData.sourceState.calculateHash();
  const reqIdObj = await RequestId.create(senderPubkey, sourceStateHash);
  const requestId = reqIdObj.toJSON();

  return { requestId, transactionHash };
}

/**
 * Return a NEW `sdkData` JSON string with `proof` attached to the tx at
 * `txIndex`. Does NOT mutate the input string. Throws on structural
 * problems (out-of-range index, non-object transactions[i], missing
 * `transactions` array).
 */
export function applyProofToSdkData(
  sdkDataJson: string,
  txIndex: number,
  proof: unknown,
): string {
  const parsed: unknown = JSON.parse(sdkDataJson);
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('applyProofToSdkData: sdkData did not parse to an object');
  }
  const transactions = (parsed as { transactions?: unknown[] }).transactions;
  if (!Array.isArray(transactions)) {
    throw new Error('applyProofToSdkData: sdkData has no transactions array');
  }
  if (txIndex < 0 || txIndex >= transactions.length) {
    throw new Error(
      `applyProofToSdkData: txIndex=${txIndex} out of range (length=${transactions.length})`,
    );
  }
  const existing = transactions[txIndex];
  if (existing === null || typeof existing !== 'object') {
    throw new Error(`applyProofToSdkData: transactions[${txIndex}] is not an object`);
  }
  transactions[txIndex] = { ...(existing as Record<string, unknown>), inclusionProof: proof };
  return JSON.stringify(parsed);
}

/**
 * Options forwarded to the underlying {@link preflightFinalize}.
 */
export interface FinalizeSourceTokenChainOptions {
  /**
   * Bounded retry budget for transient aggregator errors. Default 3
   * (matches preflightFinalize). Exhaustion triggers a hard-fail with
   * reason `'oracle-rejected'`.
   */
  readonly transientRetryCount?: number;
  /**
   * Initial backoff between retries, milliseconds. Default 500 ms.
   * Tests pass `0` to make retry semantics exercisable without timers.
   */
  readonly transientRetryDelayMs?: number;
  /** Cooperative cancellation. Forwarded to {@link preflightFinalize}. */
  readonly signal?: AbortSignal;
}

/**
 * Standard SDK routine — finalize EVERY pending tx in a source token's
 * chain. Idempotent: a fully-finalized token returns unchanged (same
 * reference, no allocation). Used by:
 *  - conservative-mode UXF sender (this issue's primary site).
 *  - any future path that needs to ensure a token's chain is fully
 *    proof-attached before being shipped or verified.
 *
 * Behavior:
 *  - Walks `token.sdkData.transactions` for entries with
 *    `inclusionProof: null` / missing (excluding the synthetic
 *    placeholder used by transient send recovery).
 *  - For each: derives `(requestId, transactionHash)` from the tx data,
 *    probes the aggregator (no re-submit — `commitment: undefined`),
 *    and patches a working sdkData JSON.
 *  - Returns a NEW {@link Token} with the patched sdkData and an
 *    updated `updatedAt` when any work was done; returns the input
 *    reference unchanged otherwise.
 *
 * Throws `SOURCE_CHAIN_HARD_FAIL` ({@link SphereError}) on irrecoverable
 * failures (race-lost, sustained PATH_NOT_INCLUDED, REQUEST_ID_MISMATCH,
 * etc.). Tokens without `sdkData` return unchanged.
 */
export async function finalizeSourceTokenChain(
  token: Token,
  aggregator: OracleProvider,
  opts: FinalizeSourceTokenChainOptions = {},
): Promise<Token> {
  if (token.sdkData === undefined || typeof token.sdkData !== 'string') {
    return token;
  }
  const pending = extractPendingChainFromSdkData(token.sdkData);
  if (pending.length === 0) {
    return token;
  }

  // Working copy of sdkData — patched in-place by persistProof on each
  // proof attachment. The closure pulls the final string after
  // preflightFinalize returns.
  let workingSdkData = token.sdkData;
  // requestId → txIndex bookkeeping so persistProof knows which slot
  // to patch. preflightFinalize calls resolveRequestId immediately
  // before submitAndAwaitProof + persistProof on the same tx, so the
  // map entry is always present when persistProof reads it.
  const requestIdToIndex = new Map<string, number>();

  await preflightFinalize([token], {
    aggregator,
    // Extract once at the top of token iteration; subsequent updates
    // to workingSdkData via persistProof are not re-scanned (preflight
    // only iterates the pendingTxs array it collected at the start).
    extractPendingChain: () => pending,
    resolveRequestId: async (_token, pendingTx) => {
      const pst = pendingTx as PendingSourceTx;
      const desc = await derivePendingTxDescriptor(pst);
      requestIdToIndex.set(desc.requestId, pst.txIndex);
      // commitment: undefined → attach-only flow. The previous owner
      // already submitted this commitment; we only need to ATTACH
      // the existing aggregator proof.
      return { requestId: desc.requestId, transactionHash: desc.transactionHash };
    },
    persistProof: ({ descriptor, proof }) => {
      const txIndex = requestIdToIndex.get(descriptor.requestId);
      if (txIndex === undefined) {
        // Cannot happen given preflightFinalize's per-tx flow, but
        // surface clearly if it ever does.
        throw new Error(
          `finalizeSourceTokenChain: persistProof had no txIndex for requestId=${descriptor.requestId.slice(0, 16)}`,
        );
      }
      workingSdkData = applyProofToSdkData(workingSdkData, txIndex, proof.proof);
    },
    transientRetryCount: opts.transientRetryCount,
    transientRetryDelayMs: opts.transientRetryDelayMs,
    signal: opts.signal,
  });

  if (workingSdkData === token.sdkData) {
    // Defensive: should not happen if pending.length > 0 advanced any tx.
    return token;
  }
  return { ...token, sdkData: workingSdkData, updatedAt: Date.now() };
}
