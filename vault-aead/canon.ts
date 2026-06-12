/**
 * Canonical signing literals shared with the token-api server (§8.1).
 *
 * These templates are the EXACT byte-strings both plans sign/verify. They are
 * pinned by the shared golden vectors (`tests/fixtures/vault-signing-vectors.json`)
 * so a divergence on either side is caught by a failing test.
 *
 * `epochCanon` is the message the vault server signs to attest a monotonic
 * storage-epoch (§5.4/§8.2). The SDK verifies the server's `epochSig` against
 * `NETWORKS[net].vaultServerKey` — a server-signed epoch bump is the only thing
 * that distinguishes a sanctioned testnet reset from a hostile rollback.
 */

/** HKDF/canon prefix for the server epoch attestation. */
export const EPOCH_CANON_PREFIX = 'unicity:vault:epoch:v1';

/**
 * Canonical epoch message: `'unicity:vault:epoch:v1\n' + network + '\n' + epoch`.
 * The epoch is concatenated as its decimal string.
 */
export function epochCanon(network: string, epoch: number | bigint): string {
  return `${EPOCH_CANON_PREFIX}\n${network}\n${epoch}`;
}

/**
 * Account-delete canonical template (scheme fixture — §8.1).
 *
 * NOTE: this `account-delete:v1` literal exists only as a golden scheme vector
 * (Task 2.2). The ACTUAL runtime account-delete template used by the provider
 * (Phase 7, matching Part A's delete route) is `unicity:vault:delete:v1` — do
 * NOT swap the runtime path onto this literal.
 */
export const ACCOUNT_DELETE_CANON_PREFIX = 'unicity:vault:account-delete:v1';

/**
 * Canonical account-delete message:
 * `'unicity:vault:account-delete:v1\n' + network + '\n' + chainPubkey + '\n' + nonce`.
 */
export function accountDeleteCanon(network: string, chainPubkey: string, nonce: string): string {
  return `${ACCOUNT_DELETE_CANON_PREFIX}\n${network}\n${chainPubkey}\n${nonce}`;
}
