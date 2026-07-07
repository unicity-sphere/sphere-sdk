/**
 * @internal Phase 5 [C] quarantine — Phase 6.C deletes this file wholesale.
 * V6-RECOVER permanent-verdict ledger management.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Token } from '../../../types';
import { logger } from '../../../core/logger';
import { STORAGE_KEYS_ADDRESS } from '../../../constants';
import { CidRefStore } from '../../../extensions/uxf/profile/cid-ref-store';
import { extractTokenIdFromSdkData } from '../tokens';

export function scheduleV6RecoverPermanentSaveRetryImpl(this: any): void {
    if (this.v6RecoverPermSaveRetryTimer) return;
    if (
      this.v6RecoverPermSaveRetryAttempts >=
      (this.constructor as any).V6_RECOVER_PERM_SAVE_MAX_ATTEMPTS
    ) {
      logger.error(
        'Payments',
        `[V6-RECOVER-PERM] save retry attempts exhausted (` +
          `${this.v6RecoverPermSaveRetryAttempts} attempts). Verdict is in ` +
          `memory only; restart will lose it. Operator intervention required.`,
      );
      return;
    }
    const attempt = this.v6RecoverPermSaveRetryAttempts;
    // 2s, 4s, 8s, 16s, 32s
    const delayMs =
      (this.constructor as any).V6_RECOVER_PERM_SAVE_RETRY_BASE_MS * Math.pow(2, attempt);
    this.v6RecoverPermSaveRetryTimer = setTimeout(async () => {
      this.v6RecoverPermSaveRetryTimer = null;
      this.v6RecoverPermSaveRetryAttempts += 1;
      try {
        await this.saveV6RecoverPermanent();
        // Success — reset counter so the next legitimate failure starts
        // fresh from a 2s delay.
        this.v6RecoverPermSaveRetryAttempts = 0;
        logger.debug(
          'Payments',
          `[V6-RECOVER-PERM] save retry succeeded after ` +
            `${attempt + 1} attempt(s)`,
        );
      } catch (err) {
        logger.error(
          'Payments',
          `[V6-RECOVER-PERM] save retry attempt ${attempt + 1} failed:`,
          err,
        );
        // Schedule the next attempt up to the cap.
        this.scheduleV6RecoverPermanentSaveRetry();
      }
    }, delayMs);
}

export function stopV6RecoverPermanentSaveRetryImpl(this: any): void {
    if (this.v6RecoverPermSaveRetryTimer) {
      clearTimeout(this.v6RecoverPermSaveRetryTimer);
      this.v6RecoverPermSaveRetryTimer = null;
    }
    this.v6RecoverPermSaveRetryAttempts = 0;
}

export async function saveV6RecoverPermanentImpl(this: any): Promise<void> {
    const entries = Array.from(this.v6RecoverPermanent.entries() as any).map(
      ([tokenId, v]: any) => ({ tokenId, reason: v.reason, ts: v.ts }),
    );

    if (entries.length === 0) {
      const storage = this.deps!.storage;
      const removeFn = (storage as { remove?: (k: string) => Promise<void> }).remove;
      if (typeof removeFn === 'function') {
        await removeFn.call(storage, STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT);
      } else {
        await this.setStorageEntry(
          STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT,
          '[]',
          'cache_index',
        );
      }
      return;
    }

    await this.setStorageEntry(
      STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT,
      JSON.stringify(entries),
      'cache_index',
    );
}

export async function restoreV6RecoverPermanentImpl(this: any): Promise<void> {
    const data = await this.deps!.storage.get(
      STORAGE_KEYS_ADDRESS.V6_RECOVER_PERMANENT,
    );
    if (!data) return;

    let entries: Array<{ tokenId: string; reason: string; ts: number }>;
    try {
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) {
        logger.error(
          'Payments',
          '[V6-RECOVER-PERM] Persisted ledger is not an array; ignoring (in-memory ledger preserved)',
        );
        return;
      }
      entries = parsed as Array<{ tokenId: string; reason: string; ts: number }>;
    } catch (err) {
      logger.error(
        'Payments',
        '[V6-RECOVER-PERM] Failed to parse persisted ledger:',
        err,
      );
      return;
    }

    let restored = 0;
    for (const e of entries) {
      if (
        typeof e?.tokenId !== 'string' ||
        e.tokenId.length === 0 ||
        typeof e.reason !== 'string' ||
        typeof e.ts !== 'number' ||
        !Number.isFinite(e.ts)
      ) {
        continue;
      }
      this.v6RecoverPermanent.set(e.tokenId, { reason: e.reason, ts: e.ts });
      restored += 1;
    }

    if (restored > 0) {
      logger.debug(
        'Payments',
        `[V6-RECOVER-PERM] Restored ${restored} permanent-verdict entries from storage`,
      );
    }

    // Issue #387 — re-apply the permanent verdict to any in-memory token
    // whose status was reset to 'pending' by the TXF round-trip during
    // `loadFromStorageData` (`determineTokenStatus` only knows the
    // `pending`/`confirmed` shapes — the application-level `'invalid'`
    // verdict is lost on every reload). The ledger is the authoritative
    // source for V6-RECOVER permanent verdicts; patching the in-memory
    // status here makes `aggregateTokens` (which already filters
    // `'invalid'`) and every downstream status consumer correct without
    // requiring a new format-version on the persisted TXF.
    this.applyV6RecoverPermanentInvalidStatus();
}

export function applyV6RecoverPermanentInvalidStatusImpl(this: any): number {
    if (this.v6RecoverPermanent.size === 0) return 0;
    let patched = 0;
    for (const [mapKey, token] of this.tokens) {
      // Issue #389 finding #10 — `'transferring'` indicates an in-flight
      // send: an outbound commit was submitted and the recipient state
      // is in the process of being claimed by the sender. Flipping that
      // status to `'invalid'` would abort the in-flight send mid-way,
      // a strictly worse outcome than letting the send complete (which
      // it will, since the ledger only applies to RECEIVED tokens — a
      // ledgered token can never be in `'transferring'` for our wallet
      // in well-formed practice). Treat `'transferring'` as a terminal-
      // for-this-cycle state the same way `'invalid'` and `'spent'`
      // are.
      if (
        token.status === 'invalid' ||
        token.status === 'spent' ||
        token.status === 'transferring'
      ) {
        continue;
      }
      if (!this.isV6RecoverPermanentToken(token, mapKey)) continue;
      token.status = 'invalid';
      // Issue #389 finding #13 — do NOT bump `updatedAt` here.
      // `determineTokenStatus` re-derives status to `'pending'` on every
      // TXF reload (see also #387 root cause), so this patch runs on
      // every load() and every sync() cycle. Bumping `updatedAt` would
      // pollute the "last meaningful change" signal that downstream
      // observers (AccountingModule, history projection, UI sort) read
      // — they would see a perpetual stream of bogus "this token just
      // changed" events even though only the load-time status re-derive
      // happened. The status flip itself is the only signal that
      // matters; readers that care about that observe it directly.
      this.tokens.set(mapKey, token);
      patched += 1;
    }
    if (patched > 0) {
      logger.debug(
        'Payments',
        `[V6-RECOVER-PERM] Patched ${patched} in-memory token(s) to status='invalid' from ledger`,
      );
    }
    return patched;
}

export function isV6RecoverPermanentTokenImpl(this: any, token: Token, mapKey?: string): boolean {
    if (this.v6RecoverPermanent.size === 0) return false;
    const canonical = extractTokenIdFromSdkData(token.sdkData);
    if (canonical && this.v6RecoverPermanent.has(canonical)) return true;
    if (mapKey && mapKey !== canonical && this.v6RecoverPermanent.has(mapKey)) {
      return true;
    }
    return false;
}
