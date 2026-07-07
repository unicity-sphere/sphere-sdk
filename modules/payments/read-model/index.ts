/**
 * modules/payments/read-model — barrel export for the read-model concern
 * submodule.
 *
 * Owns the read-only aggregation / derivation surface routed off
 * PaymentsModule during Phase 5: balance / asset views, fiat pricing,
 * token views, and the transaction-history cache + dedup + persistence
 * seam. See README.md for the full method-to-file routing plan.
 */

export * from './history';
export * from './assets';
export * from './tokens-view';
