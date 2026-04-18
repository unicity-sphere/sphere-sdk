/**
 * Profile Deriver
 *
 * Pure functions that derive transaction history, sent ledger, and
 * tombstones from the token pool. These structures are NEVER replicated
 * across Sphere instances — they are local caches per device (see
 * PROFILE-ARCHITECTURE.md §10.3/10.5 and Q1 decision).
 *
 * Why per-device:
 *  - Avoids sync errors corrupting history on every device simultaneously.
 *  - Blocks rogue instances from spoiling authoritative ledgers.
 *  - The token pool itself is the source of truth; these views are
 *    recomputable at any time.
 *
 * Derivation inputs:
 *  - Active tokens  → keys `_<tokenId>` (current ownership is ours)
 *  - Archived tokens → keys `archived-<uuid>` (we transferred these away)
 *
 * Scope & limitations (initial implementation):
 *  - We walk archived-keyed tokens to emit sent/history entries and derive
 *    tombstones. This works on the pre-save / migration-time data shape,
 *    where the PaymentsModule has explicit `archived-<id>` entries.
 *  - After a full UXF round-trip through the ProfileTokenStorageProvider
 *    the archive prefix is stripped (tokens become `_<hexTokenId>`), so
 *    the archived/active distinction is lost at that layer. When the
 *    derived cache is empty on reload and no `archived-*` keys are
 *    present, rebuild yields an empty view — callers must continue to
 *    maintain the cache imperatively (PaymentsModule.removeToken writes
 *    through) for correctness.
 *  - Oracle-based spent-checks for non-archived tokens (double-spend
 *    detection) are a future enhancement that will layer on top of the
 *    status derivation introduced in task #27 (manifest derivation).
 *
 * @module profile/deriver
 */

import type {
  TxfStorageDataBase,
  TxfTombstone,
  TxfSentEntry,
  HistoryRecord,
} from '../storage/storage-provider.js';

// =============================================================================
// Token shape helpers
// =============================================================================

/**
 * Minimal TxfToken-shaped view we rely on. Uses `unknown` for fields we
 * only forward opaquely so we don't lock into the full TxfToken surface.
 */
interface MinimalTxfToken {
  genesis?: {
    data?: {
      tokenId?: string;
      coinData?: Array<[string, string]>;
      recipient?: string;
      salt?: string;
    };
  };
  state?: {
    data?: string;
    predicate?: string;
  };
  transactions?: MinimalTxfTransaction[];
}

interface MinimalTxfTransaction {
  previousStateHash?: string;
  newStateHash?: string;
  predicate?: string;
  data?: {
    recipient?: string;
    [k: string]: unknown;
  };
  inclusionProof?: {
    transactionHash?: string;
    authenticator?: {
      signature?: string;
    };
    [k: string]: unknown;
  } | null;
}

const TOKEN_KEY_OPERATIONAL = new Set([
  '_meta',
  '_tombstones',
  '_outbox',
  '_sent',
  '_invalid',
  '_history',
  '_mintOutbox',
  '_invalidatedNametags',
]);

function isArchivedKey(key: string): boolean {
  return key.startsWith('archived-');
}

function isActiveTokenKey(key: string): boolean {
  return key.startsWith('_') && !TOKEN_KEY_OPERATIONAL.has(key);
}

function asMinimalToken(value: unknown): MinimalTxfToken | null {
  if (value && typeof value === 'object') {
    return value as MinimalTxfToken;
  }
  return null;
}

function lastTransaction(token: MinimalTxfToken): MinimalTxfTransaction | null {
  const txs = token.transactions;
  if (!txs || txs.length === 0) return null;
  return txs[txs.length - 1];
}

function firstCoin(token: MinimalTxfToken): { coinId: string; amount: string } {
  const coinData = token.genesis?.data?.coinData;
  if (!coinData || coinData.length === 0) {
    return { coinId: 'UNKNOWN', amount: '0' };
  }
  const [coinId, amount] = coinData[0];
  return { coinId: coinId ?? 'UNKNOWN', amount: amount ?? '0' };
}

/**
 * Best-effort stateHash extraction. A token's "current stateHash" in the
 * TXF model is the newStateHash of the last transaction, or — for a token
 * at genesis — the hash of the genesis itself, which we don't recompute
 * here. We return the empty string when no hash is derivable and rely on
 * the caller to skip such entries.
 */
function currentStateHash(token: MinimalTxfToken): string {
  const last = lastTransaction(token);
  if (last?.newStateHash) return last.newStateHash;
  return '';
}

// =============================================================================
// Deriver helpers
// =============================================================================

/**
 * Iterate all archived tokens (those we transferred away).
 */
function* iterateArchived(
  data: TxfStorageDataBase,
): Generator<[string, MinimalTxfToken]> {
  for (const [key, value] of Object.entries(data)) {
    if (!isArchivedKey(key)) continue;
    const token = asMinimalToken(value);
    if (!token) continue;
    yield [key, token];
  }
}

/**
 * Iterate all active tokens (those we currently own).
 */
function* iterateActive(
  data: TxfStorageDataBase,
): Generator<[string, MinimalTxfToken]> {
  for (const [key, value] of Object.entries(data)) {
    if (!isActiveTokenKey(key)) continue;
    const token = asMinimalToken(value);
    if (!token) continue;
    yield [key, token];
  }
}

// =============================================================================
// Public: Derive tombstones
// =============================================================================

/**
 * Build tombstones from archived tokens. An archived token represents one
 * we transferred away — its (tokenId, currentStateHash) pair is what we
 * must refuse to re-accept on a subsequent sync.
 *
 * Tokens without a derivable stateHash (e.g. archived before a transaction
 * was committed) are skipped — a tombstone with empty state is useless
 * for dedup.
 */
export function deriveTombstonesFromArchived(
  data: TxfStorageDataBase,
  now: number = Date.now(),
): TxfTombstone[] {
  const out: TxfTombstone[] = [];
  const seen = new Set<string>();

  for (const [, token] of iterateArchived(data)) {
    const tokenId = token.genesis?.data?.tokenId;
    if (!tokenId) continue;

    const stateHash = currentStateHash(token);
    if (!stateHash) continue;

    const key = `${tokenId}:${stateHash}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      tokenId,
      stateHash,
      timestamp: now,
    });
  }

  return out;
}

// =============================================================================
// Public: Derive sent entries
// =============================================================================

/**
 * Build sent-ledger entries from archived tokens. Each archived token's
 * last transaction carries the recipient (in `transactions[-1].data.recipient`)
 * and the transaction hash (in its inclusion proof).
 *
 * Entries missing a transaction hash fall back to the empty string —
 * consumers can filter them if a hash is required.
 */
export function deriveSentFromArchived(
  data: TxfStorageDataBase,
  now: number = Date.now(),
): TxfSentEntry[] {
  const out: TxfSentEntry[] = [];
  const seen = new Set<string>();

  for (const [, token] of iterateArchived(data)) {
    const tokenId = token.genesis?.data?.tokenId;
    if (!tokenId) continue;

    const last = lastTransaction(token);
    const recipient =
      last?.data?.recipient ?? token.genesis?.data?.recipient ?? 'unknown';
    const txHash = last?.inclusionProof?.transactionHash ?? '';

    if (seen.has(tokenId)) continue;
    seen.add(tokenId);

    out.push({
      tokenId,
      recipient,
      txHash,
      sentAt: now,
    });
  }

  return out;
}

// =============================================================================
// Public: Derive history records
// =============================================================================

/**
 * Build a best-effort transaction history from the token pool. Archived
 * tokens produce SENT entries; active tokens produce RECEIVED entries
 * (when the genesis recipient matches us or when transactions are present).
 *
 * Timestamps: when the inclusion proof carries no wallclock, entries fall
 * back to `now` so ordering across the derived set remains stable.
 */
export function deriveHistoryFromArchived(
  data: TxfStorageDataBase,
  ourAddress: string | undefined,
  now: number = Date.now(),
): HistoryRecord[] {
  const entries: HistoryRecord[] = [];
  const seenDedup = new Set<string>();
  let counter = 0;

  // SENT: archived tokens
  for (const [key, token] of iterateArchived(data)) {
    const tokenId = token.genesis?.data?.tokenId;
    if (!tokenId) continue;

    const { coinId, amount } = firstCoin(token);
    const last = lastTransaction(token);
    const recipient =
      last?.data?.recipient ?? token.genesis?.data?.recipient ?? undefined;

    const dedupKey = `SENT_derived_${key}`;
    if (seenDedup.has(dedupKey)) continue;
    seenDedup.add(dedupKey);

    entries.push({
      dedupKey,
      id: `derived-sent-${counter++}`,
      type: 'SENT',
      amount,
      coinId,
      symbol: coinId,
      timestamp: now,
      tokenId,
      recipientAddress: recipient,
    });
  }

  // RECEIVED: active tokens whose genesis targeted us (best-effort)
  if (ourAddress) {
    for (const [key, token] of iterateActive(data)) {
      const tokenId = token.genesis?.data?.tokenId;
      if (!tokenId) continue;

      const genesisRecipient = token.genesis?.data?.recipient;
      if (genesisRecipient !== ourAddress && token.transactions?.length === 0) {
        continue;
      }

      const { coinId, amount } = firstCoin(token);

      const dedupKey = `RECEIVED_derived_${key}`;
      if (seenDedup.has(dedupKey)) continue;
      seenDedup.add(dedupKey);

      entries.push({
        dedupKey,
        id: `derived-recv-${counter++}`,
        type: 'RECEIVED',
        amount,
        coinId,
        symbol: coinId,
        timestamp: now,
        tokenId,
      });
    }
  }

  // Newest first
  entries.sort((a, b) => b.timestamp - a.timestamp);
  return entries;
}
