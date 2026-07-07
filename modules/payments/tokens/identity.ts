/**
 * Token identity helpers — extract tokenId / state hash, compute
 * composite state keys, dedup keys, incremental-update detection.
 *
 * Extracted from PaymentsModule.ts:764–960 during Phase 5 (uxfv2-refactor-
 * design.md §2.1). All pure functions — behavior-preserving.
 */

import type { Token } from '../../../types';
import type { TxfToken, TxfTransaction } from '../../../types/txf';
import { sha256 } from '@noble/hashes/sha2.js';
import { getCurrentStateHash } from '../../../serialization/txf-serializer';
import { parseSdkDataCached } from './parse-cache';

/**
 * Extract token ID (genesis tokenId) from sdkData/jsonData
 */
export function extractTokenIdFromSdkData(sdkData: string | undefined): string | null {
  if (!sdkData) return null;
  return parseSdkDataCached(sdkData).tokenId;
}

/**
 * Extract state hash from sdkData/jsonData
 */
export function extractStateHashFromSdkData(sdkData: string | undefined): string {
  if (!sdkData) return '';
  return parseSdkDataCached(sdkData).stateHash;
}

/**
 * Create composite key from tokenId and stateHash.
 * Format: {tokenId}_{stateHash}
 * This uniquely identifies a token at a specific state.
 */
export function createTokenStateKey(tokenId: string, stateHash: string): string {
  return `${tokenId}_${stateHash}`;
}

/**
 * Extract composite key (tokenId_stateHash) from token.
 * Returns null if token doesn't have valid tokenId and stateHash.
 */
export function extractTokenStateKey(token: Token): string | null {
  const tokenId = extractTokenIdFromSdkData(token.sdkData);
  const stateHash = extractStateHashFromSdkData(token.sdkData);
  if (!tokenId || !stateHash) return null;
  return createTokenStateKey(tokenId, stateHash);
}

/**
 * Compute a deterministic dedup key for a pending-mint (pre-finalization)
 * token whose `getCurrentStateHash` is empty because the aggregator hasn't
 * returned an inclusion proof yet.
 *
 * We hash a canonical JSON encoding of the GENESIS DATA so the same
 * genesis always produces the same key. Explicit field-listing (not
 * pipe-delimiting, not spread of `d`) preserves null-vs-undefined-vs-''
 * distinctions and is robust against future SDK additions.
 *
 * Returned key is prefixed `pending-` so it can never collide with a real
 * state hash (64-hex SHA-256).
 */
export function pendingMintDedupKey(txf: {
  genesis?: {
    data?: {
      tokenId?: string;
      tokenType?: string;
      salt?: string;
      recipient?: string | null;
      tokenData?: string | null;
      recipientDataHash?: string | null;
    };
  };
}): string {
  const d = txf.genesis?.data ?? {};
  const canonical = JSON.stringify([
    d.tokenId ?? null,
    d.tokenType ?? null,
    d.salt ?? null,
    d.recipient ?? null,
    d.tokenData ?? null,
    d.recipientDataHash ?? null,
  ]);
  const digest = sha256(new TextEncoder().encode(canonical));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return 'pending-' + hex;
}

/**
 * Given an incoming TxfToken, return the dedup key to use for duplicate
 * detection in `importTokens`:
 *   - the token's CURRENT state hash when available
 *     (via `getCurrentStateHash`, which looks at the last transaction's
 *     `newStateHash` first, then authenticator, then genesis)
 *   - the pending-mint fallback otherwise
 *
 * Using `getCurrentStateHash` rather than reading only the genesis path
 * is load-bearing: a token that has been transferred has a genesis hash
 * that NEVER changes, but a current state hash that tracks the latest
 * transaction. If we keyed on genesis, two different live states of the
 * same token would collide as "duplicate" and valid state updates would
 * be silently dropped on re-import.
 */
export function effectiveDedupKey(
  txf: Parameters<typeof pendingMintDedupKey>[0] & Parameters<typeof getCurrentStateHash>[0],
): string {
  const stateHash = getCurrentStateHash(txf as TxfToken) ?? '';
  if (stateHash) return stateHash;
  return pendingMintDedupKey(txf);
}

/**
 * Check if two tokens have the same genesis tokenId (same token, possibly
 * different states)
 */
export function hasSameGenesisTokenId(t1: Token, t2: Token): boolean {
  const id1 = extractTokenIdFromSdkData(t1.sdkData);
  const id2 = extractTokenIdFromSdkData(t2.sdkData);
  return !!(id1 && id2 && id1 === id2);
}

/**
 * Check if two tokens are exactly the same (same tokenId AND same stateHash)
 */
export function isSameTokenState(t1: Token, t2: Token): boolean {
  const key1 = extractTokenStateKey(t1);
  const key2 = extractTokenStateKey(t2);
  return !!(key1 && key2 && key1 === key2);
}

/**
 * Check if incoming token is an incremental update
 */
export function isIncrementalUpdate(existing: TxfToken, incoming: TxfToken): boolean {
  if (existing.genesis?.data?.tokenId !== incoming.genesis?.data?.tokenId) {
    return false;
  }

  const existingTxns = existing.transactions || [];
  const incomingTxns = incoming.transactions || [];

  if (incomingTxns.length < existingTxns.length) {
    return false;
  }

  for (let i = 0; i < existingTxns.length; i++) {
    const existingTx = existingTxns[i];
    const incomingTx = incomingTxns[i];

    if (
      existingTx.previousStateHash !== incomingTx.previousStateHash ||
      existingTx.newStateHash !== incomingTx.newStateHash
    ) {
      return false;
    }
  }

  for (let i = existingTxns.length; i < incomingTxns.length; i++) {
    const newTx = incomingTxns[i] as TxfTransaction;
    if (newTx.inclusionProof === null) {
      return false;
    }
  }

  return true;
}

/**
 * Count committed transactions
 */
export function countCommittedTxns(txf: TxfToken): number {
  return (txf.transactions || []).filter(
    (tx: TxfTransaction) => tx.inclusionProof !== null,
  ).length;
}
