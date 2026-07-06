/**
 * profile-token-storage — internal sub-modules for the
 * `ProfileTokenStorageProvider` facade.
 *
 * The facade preserves a byte-identical public API; this barrel exists
 * so the facade file can import the four extracted seams from a single
 * path. Consumers of `@unicitylabs/sphere-sdk` should continue to import
 * `ProfileTokenStorageProvider` from `profile/profile-token-storage-provider`.
 *
 * @module profile/profile-token-storage
 */

export { BundleIndex, BUNDLE_KEY_PREFIX, CONSOLIDATION_WARNING_THRESHOLD } from './bundle-index.js';
export { FlushScheduler } from './flush-scheduler.js';
export { HistoryStore } from './history-store.js';
export { LifecycleManager } from './lifecycle-manager.js';
export type { ProfileTokenStorageHost, OperationalState } from './host.js';
