/**
 * modules/payments/payment-request — barrel export for the payment-request
 * concern submodule.
 *
 * See README.md for the full method-to-file routing plan. Phase 5 lands the
 * incoming request store helpers + outgoing response waiter helpers + the
 * init-time transport subscription seam here. All helpers accept explicit
 * facade-owned state via host shims — instance state stays on the
 * PaymentsModule facade.
 */

export * from './types';
export * from './incoming';
export * from './outgoing';
export * from './init-subscription';
