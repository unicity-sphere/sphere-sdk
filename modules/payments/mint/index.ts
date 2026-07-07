/**
 * modules/payments/mint — barrel export for the mint concern submodule.
 *
 * See README.md for the full method-to-file routing plan. Phase 5 lands
 * the `mintFungibleToken` extraction here as a free function; the facade
 * (`PaymentsModule.mintFungibleToken`) delegates to it while preserving the
 * public API contract.
 *
 * Not exported here: `mintNametag` — quarantined into
 * `modules/payments/legacy-v1/` per the disposition ledger.
 */

export * from './fungible';
