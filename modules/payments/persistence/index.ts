/**
 * Barrel export for the persistence submodule. See README.md.
 */

export {
  archiveTokenImpl,
  createStorageData,
  loadFromStorageData,
  type ArchiveTokenHost,
  type CreateStorageDataSnapshot,
  type LoadFromStorageDataHost,
  type LoadFromStorageDataDiff,
} from './codec';
export { runDoSave, type RunDoSaveHost } from './save';
export { getLocalTokenStorageProvider } from './providers';
export { writeKvEntry, type EntryTag } from './kv-writer-adapter';
