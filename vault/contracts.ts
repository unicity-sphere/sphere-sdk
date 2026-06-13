/**
 * vault/contracts.ts — the SINGLE SOURCE for every Token-Vault v2 contract string.
 *
 * Each signing template, domain separator and wire-reason label that the SDK and
 * the token-api server must agree on byte-for-byte is defined HERE, exactly once.
 * Every other module (and the token-api server) imports from this file rather than
 * re-typing the literal. For a financial system a typo'd duplicate would silently
 * break signature verification → funds inaccessible, so the constants live in one
 * place and are pinned by the shared golden vectors + KAT tests.
 *
 * Three groups:
 *  1. Signing templates / canons — the EXACT byte-strings both plans sign/verify
 *     (epoch attestation, account-delete, courier ack, auth challenge → see auth.ts).
 *  2. AAD / domain separators — the HKDF-info / HMAC / leaf domain prefixes.
 *  3. Wire-reason labels — the `data.reason` strings carried on the FROZEN
 *     `storage:error` / `sync:error` events (NOT new `StorageEventType` members).
 *
 * NONE of these VALUES may change: they are a wire contract proven byte-identical
 * by `tests/fixtures/vault-signing-vectors.json` and the wirekey/entryId/leaf KATs.
 */

// =============================================================================
// 1. Signing templates / canons
// =============================================================================

/** HKDF/canon prefix for the server epoch attestation (`unicity:vault:epoch:v1`). */
export const EPOCH_CANON_PREFIX = 'unicity:vault:epoch:v1';

/**
 * Canonical epoch message: `'unicity:vault:epoch:v1\n' + network + '\n' + epoch`.
 *
 * The vault server signs this to attest a monotonic storage-epoch (§5.4/§8.2); the
 * SDK verifies the server's `epochSig` against `NETWORKS[net].vaultServerKey`. The
 * epoch is concatenated as its decimal string.
 */
export function vaultEpochCanon(network: string, epoch: number | bigint): string {
  return `${EPOCH_CANON_PREFIX}\n${network}\n${epoch}`;
}

/**
 * Account-delete SCHEME prefix (`unicity:vault:account-delete:v1`).
 *
 * NOTE: this literal exists ONLY as a golden scheme vector (§8.1, Task 2.2). The
 * ACTUAL runtime account-delete template the provider signs is `delete:v1`
 * ({@link vaultDeleteCanon}) — do NOT swap the runtime path onto this literal.
 */
export const ACCOUNT_DELETE_CANON_PREFIX = 'unicity:vault:account-delete:v1';

/**
 * Canonical account-delete SCHEME message (golden fixture only):
 * `'unicity:vault:account-delete:v1\n' + network + '\n' + chainPubkey + '\n' + nonce`.
 */
export function vaultAccountDeleteCanon(network: string, chainPubkey: string, nonce: string): string {
  return `${ACCOUNT_DELETE_CANON_PREFIX}\n${network}\n${chainPubkey}\n${nonce}`;
}

/** Runtime account-delete prefix — the REAL Part A literal (`account.service.ts:11`). */
export const DELETE_CANON_PREFIX = 'unicity:vault:delete:v1';

/**
 * The REAL runtime account-delete message the wallet signs (Task 7.5, §7.4):
 * `'unicity:vault:delete:v1\n' + network + '\n' + ownerId + '\n' + nonce`.
 *
 * This is the `delete:v1` template Part A's `deleteCanon` verifies — NOT the
 * `account-delete:v1` scheme fixture above.
 */
export function vaultDeleteCanon(network: string, ownerId: string, nonce: string): string {
  return `${DELETE_CANON_PREFIX}\n${network}\n${ownerId}\n${nonce}`;
}

/** Canonical prefix for the courier ack attestation (`unicity:courier:ack:v1`). */
export const COURIER_ACK_PREFIX = 'unicity:courier:ack:v1';

/**
 * Build the exact courier-ack message bound to `(network, senderPubkey, entryId,
 * serverNonce)`: `'unicity:courier:ack:v1\n' + network + '\n' + senderPubkey +
 * '\n' + entryId + '\n' + serverNonce`.
 *
 * The signature is the fund-critical attestation: bound to the tuple so it is NOT
 * replayable across senders, deposits, or deployments. Both the SDK (signs) and
 * token-api (verifies) build this EXACT literal.
 */
export function courierAckTemplate(
  network: string,
  senderPubkey: string,
  entryId: string,
  serverNonce: string,
): string {
  return `${COURIER_ACK_PREFIX}\n${network}\n${senderPubkey}\n${entryId}\n${serverNonce}`;
}

// =============================================================================
// 2. AAD / domain separators
// =============================================================================

/** HKDF info prefix for the per-network wire-key derivation (`wire-key.ts`). */
export const WIREKEY_DOMAIN = 'unicity-vault-wirekey-v1:';

/** HKDF info for the courier entryId key (`transport/courier/entryId.ts`). */
export const ENTRYID_DOMAIN = 'unicity-courier-entryid-v1';

/** Domain-separation prefix for a vault Merkle leaf (`storage/remote/merkle.ts`). */
export const LEAF_DOMAIN = 'vault-leaf-v1';

/** HKDF info prefix for the per-network vault AEAD key (`vault-aead/derive.ts`). */
export const VAULT_AEAD_DOMAIN = 'unicity-vault-aead-v1:';

/** HKDF info for the courier AEAD key (`vault-aead/courier.ts`). */
export const COURIER_AEAD_DOMAIN = 'unicity-courier-aead-v1';

// =============================================================================
// 3. Wire-reason labels (frozen-event `data.reason`)
// =============================================================================

/**
 * The `data.reason` labels carried on the FROZEN `storage:error` / `sync:error`
 * events. These are NOT new `StorageEventType` members — they ride the existing
 * frozen event union as a data field, so the union is untouched.
 */
export const VAULT_REASON = {
  /** Signed-root anti-rollback gate tripped (`storage:error`). */
  ROLLBACK: 'rollback',
  /** Flush attempted before a successful initial load (`sync:error`). */
  AWAITING_INITIAL_LOAD: 'awaiting-initial-load',
  /** Auth handshake failed during initialize (`storage:error`). */
  AUTH: 'auth',
  /** First load failed after a successful auth (`storage:error`). */
  INITIAL_LOAD: 'initial-load',
} as const;

/** A wire-reason label value (`'rollback' | 'awaiting-initial-load' | ...`). */
export type VaultReason = (typeof VAULT_REASON)[keyof typeof VAULT_REASON];
