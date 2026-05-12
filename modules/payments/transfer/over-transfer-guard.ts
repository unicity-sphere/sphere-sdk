/**
 * Shared OVER_TRANSFER_GUARD assertion for the UXF sender orchestrators.
 *
 * Originally introduced as #142 defense-in-depth inside the instant-mode
 * orchestrator (Loop1-S5/S6 steelman fix hoists it to a shared module so
 * the conservative-mode orchestrator gets the same protection).
 *
 * **What the guard catches.** A buggy commitSources callback may
 * produce a whole-token (direct) transfer for a source that should have
 * been split-minted. The recipient receives the full source amount;
 * the sender's spend planner notices only after the bundle has shipped.
 * Without this guard, the over-send is silent. With it, the wire
 * publish is aborted and the wallet records `transfer:failed`.
 *
 * **When it fires.** AFTER `commitSources` returns (on-chain commits
 * already submitted) and BEFORE the bundle is packaged for transport.
 * A violation throws into the outer catch — the on-chain commits are
 * permanent, but the recipient never receives the bundle.
 *
 * **Fail-closed (Loop1-S5).** Earlier revision silently skipped
 * BigInt parse failures on shipped amounts — meaning a buggy /
 * hostile commitSources producing `coinData: [['UCT', 'abc']]`
 * bypassed the guard entirely (shipped=0n was always ≤ budget). The
 * shipped accumulator now THROWS on parse failure with the same
 * OVER_TRANSFER_GUARD code, surfacing the structural violation
 * instead of fail-opening. The requested-side parse failure remains a
 * silent skip — it's a budget contract input, and a malformed budget
 * means the guard treats that coin as having zero budget (still
 * fail-closed because shipped > 0 will trip).
 *
 * @module modules/payments/transfer/over-transfer-guard
 * @internal
 */

import { SphereError } from '../../../core/errors';
import type { TransferRequest } from '../../../types';

/**
 * Minimal shape the guard needs from a per-source commit result.
 * Both `InstantCommitResult` and `ConservativeCommitResult` satisfy
 * this — the guard treats `tokenClass !== 'coin'` as "skip" so
 * commit-result types without that discriminant (conservative) must
 * pass `tokenClass: undefined`; the guard still inspects
 * `recipientTokenJson.genesis.data.coinData` and treats empty/absent
 * coinData as NFT-shape (skipped).
 */
export interface GuardCommitResult {
  readonly sourceTokenId: string;
  readonly recipientTokenJson: unknown;
  readonly tokenClass?: 'coin' | 'nft';
}

/**
 * Walk each commit result's `recipientTokenJson.genesis.data.coinData`
 * and sum fungible amounts per coinId; throw OVER_TRANSFER_GUARD if
 * any coin's shipped sum exceeds the request's per-coin budget.
 *
 * @throws {SphereError} `OVER_TRANSFER_GUARD` — either an over-send
 *         was detected or a shipped amount was malformed.
 */
export function enforceOverTransferGuard(
  request: TransferRequest,
  commitResults: ReadonlyArray<GuardCommitResult>,
): void {
  const requested = new Map<string, bigint>();
  if (
    typeof request.coinId === 'string' &&
    request.coinId.length > 0 &&
    typeof request.amount === 'string' &&
    request.amount.length > 0
  ) {
    try {
      requested.set(request.coinId, BigInt(request.amount));
    } catch {
      // Malformed primary amount — treat the coin's budget as
      // 0n. Any shipped amount > 0 trips the guard (still fail-closed).
    }
  }
  for (const asset of request.additionalAssets ?? []) {
    if (asset.kind !== 'coin') continue;
    try {
      const delta = BigInt(asset.amount);
      requested.set(asset.coinId, (requested.get(asset.coinId) ?? 0n) + delta);
    } catch {
      // Same rationale — malformed budget means 0n for that coin.
    }
  }

  const shipped = new Map<string, bigint>();
  for (const r of commitResults) {
    // Skip explicit NFT entries. For conservative results that don't
    // carry tokenClass, fall through to coinData inspection — empty/
    // absent coinData is treated as NFT.
    if (r.tokenClass === 'nft') continue;
    const json = r.recipientTokenJson as
      | {
          readonly genesis?: {
            readonly data?: {
              readonly coinData?: ReadonlyArray<readonly [string, string]>;
            };
          };
        }
      | null
      | undefined;
    const coinData = json?.genesis?.data?.coinData;
    if (!Array.isArray(coinData) || coinData.length === 0) continue;
    for (const entry of coinData) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        // Structural break — the orchestrator's bundle ingest would
        // reject this downstream, but surface as OVER_TRANSFER_GUARD
        // here so the violation is detected pre-transport. Fail-closed.
        throw new SphereError(
          `OVER_TRANSFER_GUARD: malformed coinData entry in recipientTokenJson for source ${r.sourceTokenId} ` +
            '(not a 2-tuple). Refusing to publish bundle with structurally invalid coinData.',
          'OVER_TRANSFER_GUARD',
        );
      }
      const [cid, amt] = entry;
      if (typeof cid !== 'string' || typeof amt !== 'string') {
        throw new SphereError(
          `OVER_TRANSFER_GUARD: non-string coinData entry in recipientTokenJson for source ${r.sourceTokenId}. ` +
            'Refusing to publish bundle with structurally invalid coinData.',
          'OVER_TRANSFER_GUARD',
        );
      }
      let parsed: bigint;
      try {
        parsed = BigInt(amt);
      } catch {
        // Loop1-S5 — fail-closed on malformed shipped amount. The
        // previous silent-skip allowed a malformed `coinData` to
        // bypass the guard entirely (shipped=0n is always ≤ any
        // budget). Throwing surfaces the structural violation.
        throw new SphereError(
          `OVER_TRANSFER_GUARD: shipped coin amount is not a valid BigInt for source ${r.sourceTokenId} coinId=${cid} value="${amt.slice(0, 64)}". ` +
            'Refusing to publish bundle with unparseable amount.',
          'OVER_TRANSFER_GUARD',
        );
      }
      shipped.set(cid, (shipped.get(cid) ?? 0n) + parsed);
    }
  }

  for (const [cid, sentAmount] of shipped) {
    const budget = requested.get(cid) ?? 0n;
    if (sentAmount > budget) {
      throw new SphereError(
        `OVER_TRANSFER_GUARD: would ship ${sentAmount.toString()} of ` +
          `coinId=${cid} but request budget is ${budget.toString()}. ` +
          'Refusing to publish bundle. The on-chain commit(s) are already ' +
          'submitted; the recipient will not receive the bundle.',
        'OVER_TRANSFER_GUARD',
      );
    }
  }
}
