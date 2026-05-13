/**
 * UXF Storage Adapters (WU-13)
 *
 * Platform-specific storage implementations for persisting UXF packages.
 *
 * - InMemoryUxfStorage: trivial in-memory adapter for testing/ephemeral use
 * - KvUxfStorageAdapter: delegates to a key-value StorageProvider interface
 *
 * @module uxf/storage-adapters
 */

import type { UxfPackageData, UxfStorageAdapter } from './types.js';
import { packageToJson, packageFromJson } from './json.js';

// ---------------------------------------------------------------------------
// StorageProvider interface (minimal shape for KV delegation)
// ---------------------------------------------------------------------------

/**
 * Minimal key-value storage interface.
 * Compatible with sphere-sdk's StorageProvider and any similar KV store.
 */
interface KvStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// InMemoryUxfStorage
// ---------------------------------------------------------------------------

/**
 * Simple in-memory storage adapter for testing and ephemeral use.
 * Stores a deep clone of UxfPackageData via JSON round-trip.
 */
export class InMemoryUxfStorage implements UxfStorageAdapter {
  private data: string | null = null;

  async save(pkg: UxfPackageData): Promise<void> {
    // Deep clone via JSON serialization to avoid shared references
    this.data = packageToJson(pkg);
  }

  async load(): Promise<UxfPackageData | null> {
    if (this.data === null) {
      return null;
    }
    return packageFromJson(this.data);
  }

  async clear(): Promise<void> {
    this.data = null;
  }
}

// ---------------------------------------------------------------------------
// KvUxfStorageAdapter
// ---------------------------------------------------------------------------

/**
 * Adapter that stores UXF package data via an existing key-value
 * StorageProvider interface by serializing the package as JSON.
 *
 * This avoids creating new platform-specific storage implementations
 * for simple use cases. The entire package is stored under a single key.
 */
export class KvUxfStorageAdapter implements UxfStorageAdapter {
  constructor(
    private readonly storage: KvStorage,
    private readonly key: string = 'uxf_package',
  ) {}

  async save(pkg: UxfPackageData): Promise<void> {
    await this.storage.set(this.key, packageToJson(pkg));
  }

  async load(): Promise<UxfPackageData | null> {
    const json = await this.storage.get(this.key);
    return json ? packageFromJson(json) : null;
  }

  async clear(): Promise<void> {
    await this.storage.remove(this.key);
  }
}
