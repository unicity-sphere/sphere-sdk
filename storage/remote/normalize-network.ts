/**
 * normalizeVaultNetwork — the canonical NETWORK literal at the vault boundary
 * (Task 8.1, finding #9, DESIGN §7.1).
 *
 * The wallet may be configured with the network alias `'testnet'`, which the v2
 * cutover points at the SAME deployment as `'testnet2'` (same gateway, same trust
 * base, same vault). Every value the vault derives from the network literal — the
 * AEAD vault key (`deriveVaultKey`), the opaque wireKey (`wireKey`), and the
 * vault-entry / courier-envelope AAD — MUST use ONE canonical literal, or a
 * wallet that switches between the two aliases (or re-derives keys after a config
 * change) would compute a different key and be unable to open its own blobs.
 *
 * `normalizeVaultNetwork` collapses the alias: `'testnet' → 'testnet2'`; every
 * other network passes through unchanged. Call it at the vault boundary before
 * deriving any AEAD/wire/AAD material.
 *
 * ⚠️ MIGRATION-V2 TRAP — do NOT generalize this into "storage is scoped by the
 * canonical literal". It is NOT. The rest of the SDK still scopes STORAGE by the
 * LITERAL network name (`isNetworkScopedAddressKey`, per-address/per-network
 * operational state in `constants.ts`). This normalization applies ONLY at the
 * vault AEAD / wireKey / AAD boundary so the two `testnet*` aliases share vault
 * keys. Conflating the two would silently re-scope unrelated storage.
 */

/** The alias map: networks whose vault deployment is shared under one canonical name. */
const VAULT_NETWORK_ALIASES: Readonly<Record<string, string>> = {
  // v1→v2 cutover: 'testnet' points at the testnet2 deployment (shared vault).
  testnet: 'testnet2',
};

/**
 * Canonicalize a network literal for vault AEAD / wireKey / AAD derivation.
 * Aliases `'testnet' → 'testnet2'`; all other networks pass through verbatim.
 *
 * NOTE: this is the vault-boundary canonical literal ONLY — storage scoping in
 * the rest of the SDK still uses the literal network name (see the trap above).
 */
export function normalizeVaultNetwork(network: string): string {
  return VAULT_NETWORK_ALIASES[network] ?? network;
}
