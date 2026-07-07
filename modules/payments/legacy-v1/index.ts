/**
 * @internal Phase 5 [C] quarantine barrel — Phase 6.C deletes this
 * directory wholesale via `git rm -r modules/payments/legacy-v1/`.
 *
 * Do not add new functionality here. All exports below are v1-STSDK-
 * coupled machinery that becomes moot once STSDK v2 lands.
 */

export * from './send-instant';
export * from './v5-saves';
export * from './combined-transfer';
export * from './instant-split';
export * from './finalization';
export * from './commitment';
export * from './dispatch-txf';
export * from './proof-polling';
export * from './v6-recover';
export * from './mint-nametag';

// Wave 6-P2-2 — Group A helpers relocated from modules/payments/ root
// into the quarantine (still slated for Phase 6.C wholesale deletion).
// Route STSDK usage inside these files through the `stsdk-v1` alias so
// v1 runtime semantics survive the v2 SDK bump that landed in 6-P2-1.
export * from './v5-pending-shape';
export * from './extract-state-publickey';
export * from './TokenSplitCalculator';
export * from './TokenSplitExecutor';
export * from './InstantSplitExecutor';
export * from './InstantSplitProcessor';
