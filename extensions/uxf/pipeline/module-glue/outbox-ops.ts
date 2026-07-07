/**
 * OUTBOX ops — Phase 5 [B] extraction from PaymentsModule.ts.
 *
 * The legacy synthetic-entry outbox chain (`saveToOutbox` /
 * `removeFromOutbox` / `writeOutbox` / `loadOutbox`) is an
 * extension-bound concern: it exists to keep the pre-UXF (v1) test
 * suite driving the same code paths the UXF pipeline exercises via
 * its dedicated `OutboxWriter`. In Phase 6.C — once STSDK bumps to
 * v2 and the UXF pipeline owns the outbox surface end-to-end — this
 * chain retires. Until then, it stays behavior-preserving and moves
 * behind the {@link OutboxOpsHost} host shim so the facade keeps
 * one-liner private delegators.
 *
 * See uxfv2-phase-5-payments-disposition.md §"Persistence codec" and
 * §"install* worker seams" for the disposition entries this file
 * satisfies.
 */

import { STORAGE_KEYS_ADDRESS } from '../../../../constants';
import { logger } from '../../../../core/logger';
import type { TransferResult } from '../../../../types';
import { CidRefStore, type CidRef } from '../../profile/cid-ref-store';

/**
 * OUTBOX entry envelope. Kept as a re-usable public alias so callers
 * (e.g. the SendingRecoveryWorker) can typecheck against the same
 * shape without duplicating the object literal.
 */
export interface OutboxEntry {
  transfer: TransferResult;
  recipient: string;
  createdAt: number;
}

/**
 * Storage entry classification passed to the KV setEntry envelope.
 * Kept in sync with PaymentsModule's `setStorageEntry` overload.
 */
export type OutboxSetEntryType = 'token_send' | 'token_receive' | 'cache_index';

/**
 * Host shim for the OUTBOX ops. Owns:
 *   - the KV storage handle (`storage.get`);
 *   - the CID ref store (`cidRefStore`, nullable when Profile is off);
 *   - the pinned-state memo pair (`_lastPinnedOutboxJson` /
 *     `_lastPinnedOutboxRef`) — mutable through {@link setLastPinned};
 *   - `setStorageEntry` — the classified KV writer that stamps the
 *     ProfileStorageProvider W11 envelope when available and falls
 *     back to `storage.set` otherwise.
 *
 * The facade builds a fresh host at each call site (like
 * `assetsHost()` in read-model/) so the outbox ops stay decoupled
 * from PaymentsModule's field layout.
 */
export interface OutboxOpsHost {
  readonly storage: { get(key: string): Promise<string | null> };
  readonly cidRefStore: {
    pinJson<T>(value: T): Promise<CidRef>;
    fetchJson<T>(ref: CidRef): Promise<T>;
  } | null;

  /** Returns the currently memoized (JSON, ref) pair from the last pin. */
  getLastPinned(): { json: string | null; ref: CidRef | null };
  /** Update the memo after a successful pin (or clear on empty write). */
  setLastPinned(next: { json: string | null; ref: CidRef | null }): void;

  /**
   * Classified KV setter — matches the private
   * `PaymentsModule.setStorageEntry` signature.
   */
  setStorageEntry(key: string, value: string, entryType: OutboxSetEntryType): Promise<void>;
}

/**
 * Write the outbox list — via CID reference when `cidRefStore` is injected,
 * inline JSON otherwise. PROFILE-CID-REFERENCES.md §8.2 (Pattern A).
 *
 * Outbox entries wrap `TransferResult`, which contains `Token[]` with fat
 * `sdkData` (5–20 KB/token). Even modest wallets routinely push the inline
 * blob past 100 KB — hence the migration to an IPFS-pinned envelope that
 * shows up in the OpLog as a ~150-byte reference.
 */
export async function writeOutbox(host: OutboxOpsHost, list: OutboxEntry[]): Promise<void> {
  const cidRefStore = host.cidRefStore;

  if (list.length === 0) {
    // Empty outbox: write empty string to match legacy behaviour and clear
    // the memo so the next non-empty save re-pins (can't reuse a stale ref).
    // Classification: `cache_index` — the user action (token_send) has
    // already completed; this write is operational cleanup.
    await host.setStorageEntry(STORAGE_KEYS_ADDRESS.OUTBOX, '', 'cache_index');
    host.setLastPinned({ json: null, ref: null });
    return;
  }

  if (cidRefStore) {
    const json = JSON.stringify(list);
    const memo = host.getLastPinned();

    // Skip pin if plaintext is byte-identical to the last pin. Common on
    // concurrent writers that observe the same snapshot.
    if (memo.ref && memo.json === json) {
      const refStr = CidRefStore.stringifyRef(memo.ref);
      await host.setStorageEntry(STORAGE_KEYS_ADDRESS.OUTBOX, refStr, 'token_send');
      return;
    }

    const ref = await cidRefStore.pinJson(list);
    const refStr = CidRefStore.stringifyRef(ref);
    await host.setStorageEntry(STORAGE_KEYS_ADDRESS.OUTBOX, refStr, 'token_send');
    // Update memo AFTER a successful storage.set — see pendingV5 equivalent.
    host.setLastPinned({ json, ref });
    return;
  }

  // Legacy path: inline JSON (deprecated — see PROFILE-CID-REFERENCES.md).
  await host.setStorageEntry(STORAGE_KEYS_ADDRESS.OUTBOX, JSON.stringify(list), 'token_send');
}

/**
 * Load the outbox — dual-read per PROFILE-CID-REFERENCES.md §6. Detects
 * CID-ref envelope via `tryParseRef`; falls back to legacy inline JSON.
 *
 * Error handling (matches `loadPendingV5Tokens`):
 *   - CID ref present but no cidRefStore injected → throws a typed
 *     `ProfileError('CID_REF_UNREADABLE')`. The caller surfaces a
 *     configuration error rather than silently dropping outgoing transfers
 *     (which would leak user funds in the pending state).
 *   - IPFS fetch / verify / decrypt errors propagate with their typed codes.
 *   - Legacy-JSON parse failures are caught narrowly (SyntaxError only).
 */
export async function loadOutbox(host: OutboxOpsHost): Promise<OutboxEntry[]> {
  const data = await host.storage.get(STORAGE_KEYS_ADDRESS.OUTBOX);
  if (!data) return [];

  const ref = CidRefStore.tryParseRef(data);
  if (ref) {
    if (!host.cidRefStore) {
      const { ProfileError } = await import('../../profile/errors.js');
      throw new ProfileError(
        'CID_REF_UNREADABLE',
        `PaymentsModule.loadOutbox: KV at ${STORAGE_KEYS_ADDRESS.OUTBOX} ` +
          `contains a CID ref (cid=${ref.cid}) but no cidRefStore was injected. ` +
          `Outbox cannot be restored without IPFS access. ` +
          `Check PaymentsModule init — is cidRefStore provided?`,
      );
    }
    return await host.cidRefStore.fetchJson<OutboxEntry[]>(ref);
  }

  // Legacy inline JSON. Narrow catch: only swallow SyntaxError from a
  // corrupted legacy blob; unknown errors propagate.
  try {
    const parsed = JSON.parse(data);
    if (!Array.isArray(parsed)) {
      // Matches pendingV5 defensive path — log so corruption is visible
      // rather than silently returning [] (which would mask data loss and
      // allow a subsequent saveToOutbox to overwrite the forensic evidence).
      logger.error(
        'Payments',
        `[OUTBOX] Decoded data is not an array (got ${typeof parsed}); treating as empty.`,
      );
      return [];
    }
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      logger.error('Payments', '[OUTBOX] Legacy JSON parse failed (corrupted inline data):', err);
      return [];
    }
    throw err;
  }
}

/**
 * Append an entry to the outbox. Serialized through the caller's chain
 * (`enqueueOutboxOp`) — this function is a pure read-modify-write over
 * {@link loadOutbox} / {@link writeOutbox}.
 */
export async function saveToOutbox(
  host: OutboxOpsHost,
  transfer: TransferResult,
  recipient: string,
): Promise<void> {
  const outbox = await loadOutbox(host);
  outbox.push({ transfer, recipient, createdAt: Date.now() });
  await writeOutbox(host, outbox);
}

/**
 * Remove an entry (by transfer id) from the outbox. Serialized through
 * the caller's chain — pure read-modify-write.
 */
export async function removeFromOutbox(host: OutboxOpsHost, transferId: string): Promise<void> {
  const outbox = await loadOutbox(host);
  const filtered = outbox.filter((e) => e.transfer.id !== transferId);
  await writeOutbox(host, filtered);
}
