/**
 * History record AEAD codec (Task 7.4, DESIGN §5.6).
 *
 * The single-channel history log stores one AEAD-sealed `{nonce, ct}` payload per
 * client-asserted `HistoryRecord`, reusing the vault-entry seal so the operator is
 * blind to the record body. The plaintext `dedupKey` rides on the wire as the dedup
 * index (the server needs it for idempotency), but the record JSON is sealed; the
 * AAD binds `(network, ownerId, dedupKey, version=0)` so a payload cannot be replayed
 * under a different owner or dedupKey.
 *
 * The AEAD key is `deriveVaultKey(walletPriv, network)` — the same seed-derived key
 * the vault entries use; there is no decrypt-needs-address cycle.
 */

import { sealVaultEntry, openVaultEntry } from '../../vault-aead/entry';
import type { VaultEntryPayload } from '../../vault-aead/entry';
import { deriveVaultKey } from '../../vault-aead/derive';
import type { HistoryRecord } from '../storage-provider';

/** Fixed AAD version for a history payload (the log is append-only, never versioned). */
const HISTORY_VERSION = 0;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Seal a `HistoryRecord` into an AAD-bound `{nonce, ct}` payload. */
export function sealHistoryRecord(
  record: HistoryRecord,
  ownerId: string,
  walletPriv: string,
  network: string,
): VaultEntryPayload {
  return sealVaultEntry({
    network,
    ownerId,
    key: record.dedupKey,
    version: HISTORY_VERSION,
    plaintext: enc(JSON.stringify(record)),
    key32: deriveVaultKey(walletPriv, network),
  });
}

/** Open a sealed history payload, rebuilding the AAD from the dedupKey. Throws on mismatch. */
export function openHistoryRecord(
  dedupKey: string,
  payload: VaultEntryPayload,
  ownerId: string,
  walletPriv: string,
  network: string,
): HistoryRecord {
  const plaintext = openVaultEntry({
    network,
    ownerId,
    key: dedupKey,
    version: HISTORY_VERSION,
    payload,
    key32: deriveVaultKey(walletPriv, network),
  });
  return JSON.parse(dec(plaintext)) as HistoryRecord;
}
