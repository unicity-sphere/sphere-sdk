/**
 * Nametag store — pure helpers for the per-address in-memory nametag list.
 *
 * Extracted from PaymentsModule.ts:11450–11589 during Phase 5 (uxfv2-refactor-
 * design.md §2.1, uxfv2-phase-5-payments-disposition.md §"Nametag CRUD + mint").
 * Behavior-preserving: all functions operate on an explicit `list` argument
 * so the facade retains ownership of the `nametags` field but delegates the
 * actual logic here.
 *
 * NOT covered by this file: on-chain nametag minting — that path lives in
 * `NametagMinter.ts` (facade calls it directly from `mintNametag`, whose
 * disposition is `legacy-v1/` per the ledger).
 */

import type { NametagData } from '../../../types/txf';
import type { TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import { parseTxfStorageData } from '../../../serialization/txf-serializer';
import { logger } from '../../../core/logger';

/**
 * Upsert a nametag entry by name. Mutates `list` in place — matches the
 * pre-extraction semantics of `PaymentsModule.setNametag`.
 */
export function upsertNametag(list: NametagData[], nametag: NametagData): void {
  const idx = list.findIndex((n) => n.name === nametag.name);
  if (idx >= 0) {
    list[idx] = nametag;
  } else {
    list.push(nametag);
  }
}

/**
 * Get the active nametag entry.
 *
 * Prefers the entry whose name matches `claimedName` (the name advertised on
 * Nostr via `identity.nametag`). Falls back to `list[0]` when the claim is
 * unset or has no matching entry, so legacy single-nametag callers see no
 * behavior change.
 *
 * @param list - The current nametag store contents.
 * @param claimedName - `identity.nametag` — the currently claimed name, if any.
 */
export function getActiveNametag(
  list: NametagData[],
  claimedName: string | undefined,
): NametagData | null {
  if (claimedName) {
    const match = list.find((n) => n.name === claimedName);
    if (match) return match;
  }
  return list[0] ?? null;
}

/**
 * Look up a stored nametag entry by exact name. Returns `null` if the wallet
 * hasn't minted (or hasn't loaded a token for) this name.
 */
export function findNametagByName(list: NametagData[], name: string): NametagData | null {
  return list.find((n) => n.name === name) ?? null;
}

/**
 * Return a shallow copy of the nametag list — matches
 * `PaymentsModule.getNametags`'s "hand-out-a-copy" contract.
 */
export function copyNametagList(list: NametagData[]): NametagData[] {
  return [...list];
}

/**
 * Check whether ANY nametag is currently set.
 */
export function hasAnyNametag(list: NametagData[]): boolean {
  return list.length > 0;
}

/**
 * Check whether a nametag with this exact name is stored.
 */
export function hasNametagWithName(list: NametagData[], name: string): boolean {
  return list.some((n) => n.name === name);
}

/**
 * Result shape for {@link removeNametagByName}. The caller replaces its
 * `nametags` reference with `nextList` regardless of `removed` — cheap when
 * nothing changed since `nextList` is a fresh filter output either way.
 */
export interface RemoveNametagResult {
  readonly nextList: NametagData[];
  readonly removed: boolean;
}

/**
 * Remove a nametag entry by exact name. Returns a NEW array (not mutating
 * the input) plus a boolean signaling whether any entry was actually removed.
 */
export function removeNametagByName(list: NametagData[], name: string): RemoveNametagResult {
  const before = list.length;
  const nextList = list.filter((n) => n.name !== name);
  return { nextList, removed: nextList.length < before };
}

/**
 * Iterate token-storage providers looking for a non-empty nametag list.
 *
 * Used as a recovery mechanism when the in-memory `nametags` is unexpectedly
 * empty (e.g., wiped by sync or race condition) but nametag data exists in
 * storage. Returns the FIRST non-empty list found so provider-order matters —
 * mirrors the pre-extraction PaymentsModule.reloadNametagsFromStorage.
 *
 * @returns The first non-empty nametag list found, or `null` if no provider
 *   yielded one. Callers replace their in-memory list only on non-null return.
 */
export async function reloadNametagsFromProviders(
  providers: Map<string, TokenStorageProvider<TxfStorageDataBase>>,
): Promise<NametagData[] | null> {
  for (const [, provider] of providers) {
    try {
      const result = await provider.load();
      if (result.success && result.data) {
        const parsed = parseTxfStorageData(result.data);
        if (parsed.nametags.length > 0) {
          logger.debug(
            'Payments',
            `Reloaded ${parsed.nametags.length} Unicity ID(s) from storage`,
          );
          return parsed.nametags;
        }
      }
    } catch {
      // Continue to next provider
    }
  }
  return null;
}
