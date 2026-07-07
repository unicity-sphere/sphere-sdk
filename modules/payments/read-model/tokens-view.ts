/**
 * Read-model — Token view submodule.
 *
 * Extracted from PaymentsModule.ts during Phase 5 per docs/uxf/uxfv2-phase-5-
 * payments-disposition.md. Behavior-preserving pure functions + host-shim
 * accessors. The facade `PaymentsModule` retains public method signatures
 * (`getTokens`, `getToken`) as one-line delegations to the free functions
 * here.
 *
 * These are read-only views over the facade's `tokens` map — no state is
 * mutated. The V6-RECOVER ledger overlay is applied on read (per Issue
 * #389 finding #9 — see the docstring on `getTokens` below).
 */

import type { Token, TokenStatus } from '../../../types';
import { logger } from '../../../core/logger';

/**
 * Host shim for the read-model token-view functions. The facade wires
 * its `tokens` map + V6-RECOVER helpers into this interface at each
 * call site.
 */
export interface TokensViewHost {
  /** In-memory token map (facade-owned). */
  readonly tokens: ReadonlyMap<string, Token>;
  /**
   * Predicate: is this token's canonical (or fallback) id in the
   * V6-RECOVER permanent-verdict ledger? See {@link
   * PaymentsModule.isV6RecoverPermanentToken}.
   */
  isV6RecoverPermanentToken(token: Token, id?: string): boolean;
  /**
   * `true` when the V6-RECOVER ledger has at least one entry — used as
   * a short-circuit to avoid paying the per-token overlay cost when the
   * ledger is empty (the hot path).
   */
  hasV6RecoverPermanentEntries(): boolean;
}

/**
 * Get all tokens, optionally filtered by coin type and/or status.
 *
 * Issue #389 finding #9 — present-status accuracy across the cold-start
 * window. `loadFromStorageData` calls `applyV6RecoverPermanentInvalidStatus`
 * AT ITS END, but every sync() reload re-derives `Token.status` from TXF
 * transactions (`determineTokenStatus` only emits `'pending'`/`'confirmed'`).
 * Between the re-derive and the apply, the in-memory tokens map briefly
 * holds ledgered tokens at `'pending'`. AccountingModule, SwapModule, and
 * any direct API consumer reading `getTokens` during that window would
 * observe an unspendable token as `'pending'` — the precise lie #387 closed.
 * Patch on read, returning a synthesized view rather than mutating the map
 * (which would race the next save). The hot path is unaffected: when the
 * ledger is empty (the common case), `hasV6RecoverPermanentEntries` short-
 * circuits before the array walk.
 */
export function getTokens(
  host: TokensViewHost,
  filter?: { coinId?: string; status?: TokenStatus },
): Token[] {
  const ledgerActive = host.hasV6RecoverPermanentEntries();
  let tokens: Token[] = ledgerActive
    ? Array.from(host.tokens.entries(), ([id, t]) =>
        t.status !== 'invalid' &&
        t.status !== 'spent' &&
        t.status !== 'transferring' &&
        host.isV6RecoverPermanentToken(t, id)
          ? { ...t, status: 'invalid' as TokenStatus }
          : t,
      )
    : Array.from(host.tokens.values());

  if (filter?.coinId) {
    tokens = tokens.filter((t) => t.coinId === filter.coinId);
  }
  if (filter?.status) {
    tokens = tokens.filter((t) => t.status === filter.status);
  }

  return tokens;
}

/**
 * Get a single token by its local ID.
 *
 * Returns the raw stored value — no V6-RECOVER overlay is applied
 * (matching the facade's original behavior). Callers that need the
 * present-status view should route through {@link getTokens} instead.
 */
export function getToken(
  host: Pick<TokensViewHost, 'tokens'>,
  id: string,
): Token | undefined {
  const token = host.tokens.get(id);
  if (!token) {
    logger.debug(
      'Payments',
      `getToken: not found id=${id.slice(0, 16)}... mapSize=${host.tokens.size}`,
    );
  }
  return token;
}
