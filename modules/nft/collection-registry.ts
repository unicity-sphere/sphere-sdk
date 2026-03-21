/**
 * Collection Registry
 *
 * Persists NFT collection definitions and per-collection mint counters
 * using the general StorageProvider (address-scoped keys).
 *
 * @see docs/NFT-SPEC.md §3.1, §10
 */

import type { StorageProvider } from '../../storage/storage-provider.js';
import type { CollectionDefinition, CollectionRef, NFTCollectionsStorage } from './types.js';
import { STORAGE_KEYS_ADDRESS, getAddressStorageKey } from '../../constants.js';

export class CollectionRegistry {
  private collections: Map<string, CollectionDefinition> = new Map();
  private storage: StorageProvider | null = null;
  private addressId: string = '';

  /**
   * Load collection definitions from storage.
   */
  async load(storage: StorageProvider, addressId: string): Promise<void> {
    this.storage = storage;
    this.addressId = addressId;
    this.collections.clear();

    const key = getAddressStorageKey(addressId, STORAGE_KEYS_ADDRESS.NFT_COLLECTIONS);
    const raw = await storage.get(key);

    if (!raw) {
      return;
    }

    try {
      const parsed = JSON.parse(raw) as NFTCollectionsStorage;
      if (parsed && typeof parsed === 'object' && parsed.collections) {
        for (const [id, def] of Object.entries(parsed.collections)) {
          this.collections.set(id, def);
        }
      }
    } catch {
      // Corrupt data — start with empty map
    }
  }

  /**
   * Save all collection definitions to storage.
   */
  async save(): Promise<void> {
    if (!this.storage) {
      return;
    }

    const data: NFTCollectionsStorage = {
      version: 1,
      collections: Object.fromEntries(this.collections),
    };

    const key = getAddressStorageKey(this.addressId, STORAGE_KEYS_ADDRESS.NFT_COLLECTIONS);
    await this.storage.set(key, JSON.stringify(data));
  }

  /**
   * Get a collection definition by ID.
   */
  get(collectionId: string): CollectionDefinition | null {
    return this.collections.get(collectionId) ?? null;
  }

  /**
   * Store a collection definition.
   */
  set(collectionId: string, definition: CollectionDefinition): void {
    this.collections.set(collectionId, definition);
  }

  /**
   * Get all collection definitions.
   */
  getAll(): Map<string, CollectionDefinition> {
    return new Map(this.collections);
  }

  /**
   * Get the next edition number for a collection and increment the counter.
   * Reads from storage, increments, persists, returns the value BEFORE increment.
   * First call returns 1 (editions are 1-based).
   */
  async getNextEdition(collectionId: string): Promise<number> {
    if (!this.storage) {
      throw new Error('CollectionRegistry not loaded');
    }

    const key = getAddressStorageKey(
      this.addressId,
      `${STORAGE_KEYS_ADDRESS.NFT_MINT_COUNTER}_${collectionId}`,
    );

    const raw = await this.storage.get(key);
    const current = raw ? parseInt(raw, 10) : 1;
    const value = isNaN(current) ? 1 : current;

    await this.storage.set(key, String(value + 1));
    return value;
  }

  /**
   * Get the current edition count without incrementing.
   */
  async getEditionCount(collectionId: string): Promise<number> {
    if (!this.storage) {
      throw new Error('CollectionRegistry not loaded');
    }

    const key = getAddressStorageKey(
      this.addressId,
      `${STORAGE_KEYS_ADDRESS.NFT_MINT_COUNTER}_${collectionId}`,
    );

    const raw = await this.storage.get(key);
    if (!raw) {
      return 0;
    }

    const value = parseInt(raw, 10);
    return isNaN(value) ? 0 : value - 1;
  }

  /**
   * Build a CollectionRef from a definition + runtime data.
   */
  buildCollectionRef(
    collectionId: string,
    definition: CollectionDefinition,
    tokenCount: number,
    isCreator: boolean,
  ): CollectionRef {
    return {
      collectionId,
      name: definition.name,
      image: definition.image,
      creator: definition.creator,
      tokenCount,
      maxSupply: definition.maxSupply,
      isCreator,
      royalty: definition.royalty,
      transferable: definition.transferable ?? true,
    };
  }
}
