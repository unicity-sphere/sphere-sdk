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
