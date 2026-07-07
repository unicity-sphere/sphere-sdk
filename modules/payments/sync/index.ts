/**
 * modules/payments/sync — barrel export for the sync concern submodule.
 *
 * See README.md for the full method-to-file routing plan. Phase 5 lands the
 * sync engine + storage-event subscription helpers here plus the public
 * SyncOptions/SyncResult types. The facade delegates from its `sync()`,
 * `_doSync`, `subscribeToStorageEvents`, `unsubscribeStorageEvents`,
 * `debouncedSyncFromRemoteUpdate`, `getTokenStorageProviders`,
 * `updateTokenStorageProviders`, and `validate` methods.
 */

export * from './types';
export * from './engine';
export * from './storage-events';
