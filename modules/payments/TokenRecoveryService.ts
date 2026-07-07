/**
 * TokenRecoveryService — Phase 6.P2.3 rewrite.
 *
 * v1 shipped an ambitious recovery orchestrator that reached deep into
 * MintTransactionData, SplitMintReason, and per-attempt commitment state to
 * try to rebuild lost tokens after a browser crash mid-split. In practice
 * almost every non-trivial code path was `logger.debug('...not fully
 * implemented')` — the durable answer to lost tokens is the crash-safe
 * OUTBOX/SEND pipeline (Issue #166) plus the Item #14 aggregator cross-check
 * (docs/uxf/OUTBOX-SEND-FOLLOWUPS.md), not a bespoke recovery service.
 *
 * The rewrite trims the file to the pieces callers actually observed:
 *  - the `SplitRecoveryResult` shape
 *  - the outbox-entry V5 shape (metadata + bundleJson)
 *  - a `verifyToken(sphereToken)` method that answers verify + ownership +
 *    spent-state using `ITokenEngine`
 *  - `recoverOrphanedSplits` / `recoverSentTokens` / `recoverSplitBurnFailure`
 *    kept as no-op stubs returning empty results so any residual callers keep
 *    compiling. When Phase 6.P2.4+ retires the last consumer the file exits.
 */

import { logger } from '../../core/logger';
import type { ITokenEngine, SphereToken } from '../../token-engine';
import type {
  InstantSplitV5RecoveryMetadata,
  SplitRecoveryResult,
} from '../../types/instant-split';
import type { TransportProvider } from '../../transport';

// =============================================================================
// Types
// =============================================================================

export interface TokenRecoveryServiceConfig {
  /**
   * Anti-corruption engine handle. When absent, all recovery methods return
   * empty results with a diagnostic error — the caller sees the same shape as
   * the v1 "not fully implemented" branches.
   */
  readonly tokenEngine: ITokenEngine | undefined;
}

/**
 * An outbox entry with V5 recovery metadata (kept for shape compatibility
 * with the SendingRecoveryWorker + related tooling).
 */
export interface V5OutboxEntry {
  id: string;
  splitGroupId: string;
  status: string;
  metadata?: InstantSplitV5RecoveryMetadata;
  bundleJson?: string;
}

/** Options for recovering sent tokens (accepted, unused). */
export interface RecoverSentOptions {
  since?: number;
  limit?: number;
}

/** Outcome of a token-level verify: shipped alongside the class API. */
export type TokenVerifyOutcome =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'spent' }
  | { readonly kind: 'invalid'; readonly reason: string };

// =============================================================================
// Implementation
// =============================================================================

export class TokenRecoveryService {
  private readonly tokenEngine: ITokenEngine | undefined;

  constructor(config: TokenRecoveryServiceConfig) {
    this.tokenEngine = config.tokenEngine;
  }

  /**
   * Three-way verify: {@link ITokenEngine.verify}, {@link ITokenEngine.isSpent}
   * and {@link ITokenEngine.isOwnedBy} deliver the same discrimination the v1
   * recovery loop tried to hand-roll.
   */
  async verifyToken(token: SphereToken): Promise<TokenVerifyOutcome> {
    if (!this.tokenEngine) {
      return { kind: 'invalid', reason: 'token-engine-not-wired' };
    }
    try {
      const result = await this.tokenEngine.verify(token);
      if (!result.ok) {
        return { kind: 'invalid', reason: result.reason ?? 'verify-failed' };
      }
      const spent = await this.tokenEngine.isSpent(token);
      if (spent) {
        return { kind: 'spent' };
      }
      const identity = this.tokenEngine.getIdentity();
      if (!this.tokenEngine.isOwnedBy(token, identity.chainPubkey)) {
        return { kind: 'invalid', reason: 'not-owned-by-wallet' };
      }
      return { kind: 'confirmed' };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { kind: 'invalid', reason };
    }
  }

  /**
   * Bulk verify: walks each SphereToken through {@link verifyToken} and
   * groups the outcomes.
   */
  async recoverAll(tokens: ReadonlyArray<SphereToken>): Promise<{
    readonly confirmed: SphereToken[];
    readonly spent: SphereToken[];
    readonly invalid: Array<{ token: SphereToken; reason: string }>;
  }> {
    const confirmed: SphereToken[] = [];
    const spent: SphereToken[] = [];
    const invalid: Array<{ token: SphereToken; reason: string }> = [];
    for (const token of tokens) {
      const outcome = await this.verifyToken(token);
      switch (outcome.kind) {
        case 'confirmed':
          confirmed.push(token);
          break;
        case 'spent':
          spent.push(token);
          break;
        case 'invalid':
          invalid.push({ token, reason: outcome.reason });
          break;
      }
    }
    return { confirmed, spent, invalid };
  }

  /**
   * Historical shape kept for outbox-worker compatibility. The crash-safe
   * OUTBOX/SEND pipeline (Issue #166) is now the authoritative recovery
   * surface; this method returns an empty result and logs a diagnostic.
   */
  async recoverOrphanedSplits(
    outboxEntries: V5OutboxEntry[],
    _onTokenRecovered?: (token: SphereToken, splitGroupId: string) => Promise<void>,
  ): Promise<SplitRecoveryResult> {
    const startTime = performance.now();
    const result: SplitRecoveryResult = {
      splitsRecovered: 0,
      changeTokensRecovered: 0,
      errors: [],
      durationMs: 0,
    };
    logger.debug(
      'Recovery',
      `recoverOrphanedSplits stub: ${outboxEntries.length} entries — see OUTBOX/SEND pipeline`,
    );
    result.durationMs = performance.now() - startTime;
    return result;
  }

  /**
   * Historical shape kept for compatibility. Nostr-driven recovery moved to
   * the SendingRecoveryWorker + retention verifier; this stub records the
   * call for diagnostic purposes only.
   */
  async recoverSentTokens(
    _transport: TransportProvider,
    _options?: RecoverSentOptions,
  ): Promise<SplitRecoveryResult> {
    logger.debug('Recovery', 'recoverSentTokens stub — routed to OUTBOX/SEND pipeline');
    return {
      splitsRecovered: 0,
      changeTokensRecovered: 0,
      errors: [],
      durationMs: 0,
    };
  }
}

/**
 * Factory function for creating TokenRecoveryService.
 */
export function createTokenRecoveryService(
  config: TokenRecoveryServiceConfig,
): TokenRecoveryService {
  return new TokenRecoveryService(config);
}
