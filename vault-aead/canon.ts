/**
 * Canonical signing literals shared with the token-api server (§8.1).
 *
 * These templates are now DEFINED ONCE in `vault/contracts.ts` (the single-source
 * contract module). This file is a thin compatibility shim: it re-exports them
 * under the historical `epochCanon` / `deleteCanon` / `accountDeleteCanon` names so
 * existing call sites keep working. No literal lives here — see `vault/contracts.ts`.
 *
 * `epochCanon` is the message the vault server signs to attest a monotonic
 * storage-epoch (§5.4/§8.2). The SDK verifies the server's `epochSig` against
 * `NETWORKS[net].vaultServerKey` — a server-signed epoch bump is the only thing
 * that distinguishes a sanctioned testnet reset from a hostile rollback.
 *
 * The `account-delete:v1` literal exists ONLY as a golden scheme vector; the REAL
 * runtime account-delete template is `delete:v1` (see `vault/contracts.ts`).
 */

export {
  EPOCH_CANON_PREFIX,
  vaultEpochCanon as epochCanon,
  ACCOUNT_DELETE_CANON_PREFIX,
  vaultAccountDeleteCanon as accountDeleteCanon,
  DELETE_CANON_PREFIX,
  vaultDeleteCanon as deleteCanon,
} from '../vault/contracts';
