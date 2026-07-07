/**
 * Token export — TXF wire-format snapshot of owned tokens.
 *
 * Extracted from PaymentsModule.ts:8380–8408 during Phase 5 (uxfv2-refactor-
 * design.md §2.1 and uxfv2-phase-5-payments-disposition.md). Behavior-
 * preserving: same option semantics + same skip rules as the pre-split
 * facade method.
 */

import type { Token } from '../../../types';
import type { TxfToken } from '../../../types/txf';
import { tokenToTxf } from '../../../serialization/txf-serializer';

export interface ExportTokensOptions {
  ids?: readonly string[];
  coinId?: string;
  includeUnconfirmed?: boolean;
}

export interface ExportedToken {
  readonly localId: string;
  readonly genesisTokenId: string;
  readonly txf: TxfToken;
}

/**
 * Filter + serialize a wallet's tokens into TXF wire-format triples.
 *
 * @param tokens - The wallet's in-memory token map (typically
 *   `PaymentsModule.tokens`).
 * @param options - Optional filters. See {@link ExportTokensOptions}.
 * @returns Array of `{ localId, genesisTokenId, txf }` triples. A
 *   token is skipped if its `sdkData` does not parse to a valid TXF
 *   shape (should not happen for healthy tokens).
 */
export function exportTokensFromMap(
  tokens: ReadonlyMap<string, Token>,
  options?: ExportTokensOptions,
): ExportedToken[] {
  let candidates = Array.from(tokens.values());
  if (options?.ids) {
    const idSet = new Set(options.ids);
    candidates = candidates.filter((t) => idSet.has(t.id));
  }
  if (options?.coinId) {
    candidates = candidates.filter((t) => t.coinId === options.coinId);
  }
  if (!options?.includeUnconfirmed) {
    candidates = candidates.filter((t) => t.status === 'confirmed');
  }

  const out: ExportedToken[] = [];
  for (const token of candidates) {
    const txf = tokenToTxf(token);
    if (!txf) continue;
    const genesisTokenId = txf.genesis?.data?.tokenId;
    if (!genesisTokenId) continue;
    out.push({ localId: token.id, genesisTokenId, txf });
  }
  return out;
}
