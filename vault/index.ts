/**
 * vault — single-source contract + auth surface for Token-Vault v2.
 *
 * Re-exports the contract module (every signing template, domain separator and
 * wire-reason label, defined ONCE in `contracts.ts`) and the wallet→backend auth
 * recipe (`vault/auth.ts`). The token-api server imports the auth verifier + the
 * canons/domains from here so both sides share one definition.
 */

export {
  // signing templates / canons
  EPOCH_CANON_PREFIX,
  vaultEpochCanon,
  ACCOUNT_DELETE_CANON_PREFIX,
  vaultAccountDeleteCanon,
  DELETE_CANON_PREFIX,
  vaultDeleteCanon,
  COURIER_ACK_PREFIX,
  courierAckTemplate,
  // AAD / domain separators
  WIREKEY_DOMAIN,
  ENTRYID_DOMAIN,
  LEAF_DOMAIN,
  VAULT_AEAD_DOMAIN,
  COURIER_AEAD_DOMAIN,
  // wire-reason labels
  VAULT_REASON,
} from './contracts';
export type { VaultReason } from './contracts';

export { VAULT_AUTH_PREFIX, vaultAuthChallenge, verifyVaultAuth } from './auth';
export type { VaultAuthChallengeBody, VerifyVaultAuthParams } from './auth';
