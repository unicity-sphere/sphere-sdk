/**
 * modules/payments/nametag — barrel export for the nametag concern submodule.
 *
 * See README.md for the full method-to-file routing plan. Phase 5 lands the
 * per-address nametag KV store helpers here plus the availability probe;
 * on-chain minting stays in the sibling `NametagMinter.ts` (facade delegates
 * to it directly from `mintNametag`, whose disposition is `legacy-v1/`).
 */

export * from './store';
export * from './availability';
